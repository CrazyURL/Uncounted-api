// ════════════════════════════════════════════════════════════════════
// BM v10 — GPU 처리 워커 (백그라운드 폴링 + 운영 안정성)
// ════════════════════════════════════════════════════════════════════
//
// WHY
//   App 이 raw audio 를 iwinv S3 에 업로드 → sessions.raw_audio_url 채워짐.
//   본 워커가 30초마다 폴링하여 1건씩 voice_api 로 전달, 결과를 DB+S3 에 반영.
//
// 흐름 (1 trace)
//   1. 픽업: pending 신규 OR failed 재시도 (retry_count<3 + 30분 경과)
//   2. status='running' (singleton lock) + gpu_started_at = NOW()
//   3. iwinv S3 에서 raw audio 다운로드
//   4. voice_api POST /api/v1/transcribe (multipart, diarize+split+pii+denoise)
//      - 503: status 'pending' 으로 되돌리고 60초 backoff (retry_count 증가 X)
//   5. voice_api GET /api/v1/jobs/{task_id} 폴링 (1초 간격, max 5분)
//   6. utterances 분리 결과를 utterances 테이블 + iwinv S3 에 저장
//   7. sessions UPDATE: status='done' + 5단계 모두 'done'
//
//   실패 시:
//   - status='failed', retry_count++, gpu_last_error=메시지
//   - retry_count<3 이면 30분 후 자동 재시도
//   - retry_count>=3 이면 영구 failed (admin 수동 재시도 필요)
//
// stuck 감지 (별도 sweep, 5분마다):
//   running 상태로 10분 초과 시 강제 failed 전환 (worker 가 죽었거나 hang 한 경우)
//
// 단일 인스턴스 보장:
//   GPU_WORKER_ENABLED=true 인스턴스만 워커 시작.
//   추가 안전장치: pickNextSession 의 conditional UPDATE (race-safe)
// ════════════════════════════════════════════════════════════════════

import { GetObjectCommand } from '@aws-sdk/client-s3'
import { supabaseAdmin } from '../lib/supabase.js'
import { s3Client, S3_AUDIO_BUCKET, uploadObject, objectExists } from '../lib/s3.js'
import { getAudioStatsFromBuffer } from '../lib/audio/ffmpegProcessor.js'
import { computeQualityScore, computeQualityGrade } from '../lib/export/qualityMetricsService.js'

const POLL_INTERVAL_MS = 30_000  // safety net 폴링 30초 (immediate trigger 우선, 이건 fallback)
const POLL_BACKOFF_503_MS = 60_000  // voice_api 503 시 60초 추가 대기
const STUCK_SWEEP_INTERVAL_MS = 5 * 60_000  // stuck 감지 5분마다
const STUCK_THRESHOLD_MS = 10 * 60_000  // running 10분 초과 = stuck
const RETRY_DELAY_MIN = 30  // failed 후 30분 뒤 재시도
const MAX_RETRY_COUNT = 3

// 워커 동시성 — 단일 GPU 가 bottleneck 이라 2 가 sweet spot.
// I/O (S3 download/upload) 와 voice_api GPU 처리 중복 → 약간 throughput 향상.
// voice_api MAX_ACTIVE_JOBS 가 이 값 이상이어야 503 안 남.
const WORKER_CONCURRENCY = Math.max(1, parseInt(process.env.WORKER_CONCURRENCY ?? '2', 10))

const VOICE_API_URL = process.env.VOICE_API_URL ?? 'http://localhost:8001'
const VOICE_API_POLL_INTERVAL_MS = 1_000
const VOICE_API_MAX_WAIT_MS = 5 * 60 * 1000

let isShuttingDown = false
let lastStuckSweepAt = 0

// ── Wakeup 시그널 — immediate trigger 용 cancellable sleep ────────────
// /api/storage/raw-audio 핸들러가 raw audio 업로드 직후 호출 → 워커 즉시 깨어남.
// 30초 폴링 대기 latency 제거. 여러 trigger 가 동시 도착해도 한 번만 깨어남
// (resolved Promise 의 추가 resolve 는 no-op).
interface Wakeup {
  promise: Promise<void>
  resolve: () => void
  resolved: boolean
}
let wakeup: Wakeup | null = null
function getWakeup(): Wakeup {
  if (!wakeup || wakeup.resolved) {
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    const w: Wakeup = {
      promise,
      resolve: () => {
        if (!w.resolved) {
          w.resolved = true
          resolve()
        }
      },
      resolved: false,
    }
    wakeup = w
  }
  return wakeup
}

/** raw audio 업로드 핸들러가 호출 — 워커 즉시 1 tick 진행 */
export function triggerWorker(reason = 'unknown'): void {
  getWakeup().resolve()
  // 로그는 trigger 출처 추적용 (debounce 검증)
  console.log(`[gpu-worker] triggered (${reason})`)
}

// ── voice_api 응답 타입 ─────────────────────────────────────────────
interface VoiceApiUtterance {
  index: number
  start_sec: number
  end_sec: number
  duration_sec: number
  speaker_id: string
  transcript_text: string
  audio_filename: string
  words?: unknown
}

interface VoiceApiSpeaker {
  speaker_label: string
  embedding?: number[] | null
  speaker_role?: string | null
  speaker_role_source?: string | null
  speaker_gender?: string | null
  speaker_voice_age_range?: string | null
  speaker_speech_age_range?: string | null
  speaker_speech_age_model_version?: string | null
  speaker_relation?: string | null
}

interface VoiceApiTopicSegment {
  segment_index: number
  topic?: string | null
  start_ms?: number | null
  end_ms?: number | null
  utterance_indices: number[]
}

interface VoiceApiJobResult {
  task_id: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  language?: string
  duration_seconds?: number
  segments?: unknown[]
  full_text?: string
  pii_summary?: unknown
  diarization_enabled?: boolean
  utterances?: VoiceApiUtterance[]
  speakers?: VoiceApiSpeaker[]
  topic_segments?: VoiceApiTopicSegment[]
  speaker_audio?: unknown
  error?: string
}

// 503 backoff 시그널 — 호출자가 retry_count 증가 안 시키도록
class Voice503Error extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'Voice503Error'
  }
}

// pre-fetch 결과 — 다음 세션의 S3 다운로드 + voice_api submit 이 완료된 상태
interface PrefetchResult {
  session: { id: string; user_id: string; raw_audio_url: string; isRetry: boolean; consent_status?: string; gpu_last_error?: string | null }
  taskId: string
}

// ── pre-fetch: 다음 세션을 미리 claim + S3 다운로드 + voice_api submit ─
// 절대 throw 하지 않음. 실패 시 DB claim 되돌리고 null 반환.
async function prefetchNextSession(excludeSessionId: string): Promise<PrefetchResult | null> {
  // pending 신규만 pre-fetch (failed 재시도는 타이밍 민감 — 30분 조건이 있어 skip)
  const { data: pendingRow, error } = await supabaseAdmin
    .from('sessions')
    .select('id, user_id, raw_audio_url')
    .eq('gpu_upload_status', 'pending')
    .not('raw_audio_url', 'is', null)
    .neq('id', excludeSessionId)
    .order('raw_audio_uploaded_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error || !pendingRow) return null

  const claimed = await tryClaim(pendingRow as RowSlim, false)
  if (!claimed) return null

  try {
    const ext = (claimed.raw_audio_url.split('.').pop() ?? 'm4a').toLowerCase()
    const audioBuffer = await downloadRawAudio(claimed.raw_audio_url)
    const taskId = await submitToVoiceApi(audioBuffer, ext)
    console.log(`[gpu-worker] prefetch ok session=${claimed.id} task_id=${taskId}`)
    return { session: claimed, taskId }
  } catch (err: any) {
    const logTag = err instanceof Voice503Error
      ? 'prefetch 503 — voice_api queue full'
      : 'prefetch failed'
    console.warn(`[gpu-worker] ${logTag} session=${claimed.id}: ${err.message} — reverting`)
    await supabaseAdmin
      .from('sessions')
      .update({ gpu_upload_status: 'pending', gpu_started_at: null, gpu_last_error: null })
      .eq('id', claimed.id)
    return null
  }
}

// ── stuck sweep — running 10분 초과 → S3 확인 후 pending/failed 전환 ────────────
async function sweepStuckSessions(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString()
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('id, raw_audio_url')
    .eq('gpu_upload_status', 'running')
    .lt('gpu_started_at', cutoff)

  if (error) {
    console.error('[gpu-worker] sweepStuck error:', error.message)
    return
  }
  if (!data || data.length === 0) return

  let pendingCount = 0
  let failedCount = 0
  for (const row of data) {
    // raw_audio_url 이 있고 S3 에 파일이 존재하면 업로드는 이미 완료 → pending 재시도
    // 파일이 없으면 업로드 자체가 실패한 것 → failed
    let hasFile = false
    if (row.raw_audio_url) {
      try {
        hasFile = await objectExists(S3_AUDIO_BUCKET, row.raw_audio_url)
      } catch {
        // S3 확인 실패 시 안전하게 pending 처리 (실제 파일 여부 불명)
        hasFile = true
      }
    }

    const newStatus = hasFile ? 'pending' : 'failed'
    const errMsg = hasFile
      ? 'stuck — running 10분 초과 (워커 사망 또는 hang). 파일 존재 확인, 자동 재시도.'
      : 'stuck — running 10분 초과 (워커 사망 또는 hang). 파일 미존재, 업로드 재시도 필요.'
    await supabaseAdmin
      .from('sessions')
      .update({ gpu_upload_status: newStatus, gpu_last_error: errMsg })
      .eq('id', row.id)

    if (hasFile) pendingCount++
    else failedCount++
  }

  console.warn(
    `[gpu-worker] sweepStuck: ${data.length} stuck session(s) — pending(파일있음)=${pendingCount}, failed(파일없음)=${failedCount}`,
  )

  // Feature 1: both_agreed + raw_audio_url IS NULL 영구 stall 경보
  try {
    const { count: nullCount, error: nullErr } = await supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('consent_status', 'both_agreed')
      .is('raw_audio_url', null)
      .neq('gpu_upload_status', 'done')
      .neq('gpu_upload_status', 'skipped')
    if (!nullErr && (nullCount ?? 0) > 5) {
      console.warn(
        `[gpu-worker] sweepStuck: ${nullCount} sessions both_agreed + raw_audio_url IS NULL (영구 stall 의심) — 수동 조치 필요`,
      )
    }
  } catch (e: any) {
    console.error('[gpu-worker] sweepStuck null_audio check error:', e.message)
  }
}

// ── Feature 2: segment_id=NULL 발화 역할당 sweep ─────────────────────
async function sweepSegmentBackfill(): Promise<void> {
  try {
    const { data: orphans, error: orphanErr } = await supabaseAdmin
      .from('utterances')
      .select('id, session_id, start_ms')
      .is('segment_id', null)
      .limit(200)
    if (orphanErr) {
      console.error('[gpu-worker] sweepSegmentBackfill orphan query error:', orphanErr.message)
      return
    }
    if (!orphans || orphans.length === 0) return

    const sessionMap = new Map<string, typeof orphans>()
    for (const utt of orphans) {
      const arr = sessionMap.get(utt.session_id) ?? []
      arr.push(utt)
      sessionMap.set(utt.session_id, arr)
    }

    let patched = 0
    for (const [sessionId, utts] of sessionMap) {
      const { data: segments, error: segErr } = await supabaseAdmin
        .from('session_segments')
        .select('id, start_ms, end_ms')
        .eq('session_id', sessionId)
        .order('start_ms', { ascending: true })
      if (segErr || !segments || segments.length === 0) continue

      for (const utt of utts) {
        const uttMs = utt.start_ms ?? 0
        let matchedSegId: string | null = null
        for (const seg of segments) {
          if (seg.start_ms <= uttMs && uttMs <= seg.end_ms) {
            matchedSegId = seg.id
            break
          }
        }
        if (!matchedSegId) {
          const nearest = segments.reduce((a, b) =>
            Math.abs(a.start_ms - uttMs) <= Math.abs(b.start_ms - uttMs) ? a : b,
          )
          matchedSegId = nearest.id
        }
        const { error: updErr } = await supabaseAdmin
          .from('utterances')
          .update({ segment_id: matchedSegId })
          .eq('id', utt.id)
        if (updErr) {
          console.warn(`[gpu-worker] sweepSegmentBackfill update failed for ${utt.id}:`, updErr.message)
        } else {
          patched++
        }
      }
    }
    if (patched > 0) {
      console.log(
        `[gpu-worker] sweepSegmentBackfill: ${patched} orphan utterances patched in ${sessionMap.size} sessions`,
      )
    }
  } catch (e: any) {
    console.error('[gpu-worker] sweepSegmentBackfill error:', e.message)
  }
}

// ── pickup: 신규 pending OR failed 재시도 ────────────────────────────
async function pickNextSession(): Promise<{
  id: string
  user_id: string
  raw_audio_url: string
  isRetry: boolean
  consent_status?: string
  gpu_last_error?: string | null
} | null> {
  // 우선순위 1: 신규 pending
  const { data: pendingRow, error: pendingErr } = await supabaseAdmin
    .from('sessions')
    .select('id, user_id, raw_audio_url, consent_status, gpu_last_error')
    .eq('gpu_upload_status', 'pending')
    .not('raw_audio_url', 'is', null)
    .order('raw_audio_uploaded_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (pendingErr) {
    console.error('[gpu-worker] pickup pending error:', pendingErr.message)
    return null
  }
  if (pendingRow) {
    return await tryClaim(pendingRow as RowSlim, false)
  }

  // 우선순위 2: failed 재시도 큐 (retry_count < 3 + 30분 경과)
  const retryCutoff = new Date(Date.now() - RETRY_DELAY_MIN * 60_000).toISOString()
  const { data: failedRow, error: failedErr } = await supabaseAdmin
    .from('sessions')
    .select('id, user_id, raw_audio_url, gpu_retry_count, consent_status, gpu_last_error')
    .eq('gpu_upload_status', 'failed')
    .lt('gpu_retry_count', MAX_RETRY_COUNT)
    .lt('updated_at', retryCutoff)
    .not('raw_audio_url', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (failedErr) {
    console.error('[gpu-worker] pickup retry error:', failedErr.message)
    return null
  }
  if (failedRow) {
    return await tryClaim(failedRow as RowSlim, true)
  }

  return null
}

interface RowSlim {
  id: string
  user_id: string
  raw_audio_url: string
  consent_status?: string
  gpu_last_error?: string | null
}

// race-safe claim — conditional UPDATE 가 0 row 면 다른 인스턴스가 이미 픽
async function tryClaim(
  row: RowSlim,
  isRetry: boolean,
): Promise<{
  id: string
  user_id: string
  raw_audio_url: string
  isRetry: boolean
  consent_status?: string
  gpu_last_error?: string | null
} | null> {
  const fromStatus = isRetry ? 'failed' : 'pending'
  const { count, error } = await supabaseAdmin
    .from('sessions')
    .update(
      {
        gpu_upload_status: 'running',
        gpu_started_at: new Date().toISOString(),
        gpu_uploaded_at: new Date().toISOString(),
      },
      { count: 'exact' },
    )
    .eq('id', row.id)
    .eq('gpu_upload_status', fromStatus)

  if (error || !count || count === 0) {
    return null
  }
  return { ...row, isRetry }
}

// ── iwinv S3 raw audio 다운로드 ────────────────────────────────────
async function downloadRawAudio(rawAudioUrl: string): Promise<Buffer> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: S3_AUDIO_BUCKET, Key: rawAudioUrl }),
  )
  if (!response.Body) {
    throw new Error(`Empty S3 response: ${rawAudioUrl}`)
  }
  const bytes = await response.Body.transformToByteArray()
  return Buffer.from(bytes)
}

// ── voice_api POST /api/v1/transcribe ───────────────────────────────
async function submitToVoiceApi(audioBuffer: Buffer, ext: string): Promise<string> {
  const url =
    `${VOICE_API_URL}/api/v1/transcribe` +
    `?language=ko&diarize=true&split_by_utterance=true&mask_pii=true&denoise=true`

  const blob = new Blob([audioBuffer], { type: 'application/octet-stream' })
  const form = new FormData()
  form.append('file', blob, `raw.${ext}`)

  const res = await fetch(url, { method: 'POST', body: form })
  if (res.status === 503) {
    const text = await res.text().catch(() => '')
    throw new Voice503Error(`voice_api queue full (503): ${text.slice(0, 100)}`)
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`voice_api transcribe failed: ${res.status} ${text.slice(0, 200)}`)
  }
  const json = (await res.json()) as { task_id: string; status: string }
  return json.task_id
}

// ── voice_api job 폴링 ──────────────────────────────────────────────
async function pollVoiceApiJob(taskId: string): Promise<VoiceApiJobResult> {
  const start = Date.now()
  while (Date.now() - start < VOICE_API_MAX_WAIT_MS) {
    const res = await fetch(`${VOICE_API_URL}/api/v1/jobs/${taskId}`)
    if (res.status === 500) {
      const json = (await res.json()) as VoiceApiJobResult
      return { ...json, status: 'failed' }
    }
    if (!res.ok) {
      throw new Error(`voice_api job poll failed: ${res.status}`)
    }
    const json = (await res.json()) as VoiceApiJobResult
    if (json.status === 'completed' || json.status === 'failed') {
      return json
    }
    await sleep(VOICE_API_POLL_INTERVAL_MS)
  }
  throw new Error(`voice_api job ${taskId} timeout after ${VOICE_API_MAX_WAIT_MS / 1000}s`)
}

// ── utterance WAV 다운로드 (voice_api → iwinv S3) ──────────────────
async function downloadUtteranceWav(taskId: string, filename: string): Promise<Buffer> {
  const res = await fetch(
    `${VOICE_API_URL}/api/v1/jobs/${taskId}/audio/${encodeURIComponent(filename)}`,
  )
  if (!res.ok) {
    throw new Error(`utterance WAV download failed: ${res.status} ${filename}`)
  }
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

// ── STAGE 15: 화자 역할 판별 헬퍼 ──────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

async function enrichSpeakersWithRole(
  speakers: VoiceApiSpeaker[],
  userId: string,
): Promise<VoiceApiSpeaker[]> {
  if (speakers.length === 0) return speakers

  const strip = (spk: VoiceApiSpeaker): VoiceApiSpeaker => {
    const { embedding: _emb, ...rest } = spk
    return rest
  }

  if (speakers.length === 1) {
    return [{ ...strip(speakers[0]), speaker_role: 'self', speaker_role_source: 'single_speaker' }]
  }

  const { data: profile } = await supabaseAdmin
    .from('voice_profiles')
    .select('reference_embedding, enrollment_status')
    .eq('user_id', userId)
    .maybeSingle()

  const refEmbedding = profile?.reference_embedding as number[] | null | undefined
  if (!refEmbedding || profile?.enrollment_status !== 'enrolled') {
    return speakers.map(spk => ({
      ...strip(spk),
      speaker_role: 'other',
      speaker_role_source: 'default',
    }))
  }

  let bestIdx = -1
  let bestSim = -Infinity
  for (let i = 0; i < speakers.length; i++) {
    const emb = speakers[i].embedding
    if (!emb) continue
    const sim = cosineSimilarity(refEmbedding, emb)
    if (sim > bestSim) {
      bestSim = sim
      bestIdx = i
    }
  }

  return speakers.map((spk, i) => ({
    ...strip(spk),
    speaker_role: i === bestIdx ? 'self' : 'other',
    speaker_role_source: 'embedding_match',
  }))
}

// ── utterances INSERT + sessions UPDATE 'done' ─────────────────────
async function persistResults(
  session: { id: string; user_id: string; raw_audio_url: string },
  taskId: string,
  result: VoiceApiJobResult,
): Promise<void> {
  const utterances = result.utterances ?? []
  if (utterances.length === 0) {
    console.warn(`[gpu-worker] session ${session.id}: 0 utterances returned — marking quality_status failed`)
    const now = new Date().toISOString()
    await supabaseAdmin
      .from('sessions')
      .update({
        gpu_upload_status: 'done',
        stt_status: 'done',
        stt_at: now,
        diarize_status: 'done',
        diarize_at: now,
        gpu_pii_status: 'done',
        gpu_pii_at: now,
        auto_label_status: 'skipped',
        quality_status: 'failed',
        utterance_count: 0,
        gpu_last_error: 'voice_api_0_utterances',
      })
      .eq('id', session.id)
    return
  }

  // ── STAGE 15: session_speakers ─────────────────────────────────────
  const speakerLabelToId = new Map<string, string>()
  const speakersData = result.speakers ?? []
  for (const spk of speakersData) {
    const { data: spkData, error: spkErr } = await supabaseAdmin
      .from('session_speakers')
      .upsert(
        {
          session_id: session.id,
          speaker_label: spk.speaker_label,
          speaker_role: spk.speaker_role ?? null,
          speaker_role_source: spk.speaker_role_source ?? null,
          speaker_gender: spk.speaker_gender ?? null,
          speaker_voice_age_range: spk.speaker_voice_age_range ?? null,
          speaker_speech_age_range: spk.speaker_speech_age_range ?? null,
          speaker_speech_age_model_version: spk.speaker_speech_age_model_version ?? null,
          speaker_relation: spk.speaker_relation ?? null,
        },
        { onConflict: 'session_id,speaker_label' },
      )
      .select('id')
      .single()
    if (spkErr) {
      console.warn(
        `[gpu-worker] session_speakers upsert failed (${spk.speaker_label}): ${spkErr.message}`,
      )
    } else if (spkData) {
      speakerLabelToId.set(spk.speaker_label, spkData.id)
    }
  }

  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i]
    const seq = i + 1
    const seqPadded = String(seq).padStart(3, '0')
    const utteranceId = `utt_${session.id}_${seqPadded}`
    const storagePath = `utterances/${session.id}/${utteranceId}.wav`

    const wavBuffer = await downloadUtteranceWav(taskId, u.audio_filename)
    await uploadObject(S3_AUDIO_BUCKET, storagePath, new Uint8Array(wavBuffer), 'audio/wav')

    let utteranceQualityScore: number | null = null
    let utteranceQualityGrade: string | null = null
    try {
      const stats = await getAudioStatsFromBuffer(Buffer.from(wavBuffer))
      const { qualityScore } = computeQualityScore(stats)
      utteranceQualityScore = qualityScore
      utteranceQualityGrade = computeQualityGrade(qualityScore)
    } catch {
      // 품질 계산 실패 시 null 유지 — utterance는 정상 저장
    }

    const { error } = await supabaseAdmin.from('utterances').upsert(
      {
        id: utteranceId,
        session_id: session.id,
        chunk_id: null,
        user_id: session.user_id,
        sequence_in_chunk: seq,
        sequence_order: seq,
        speaker_id: u.speaker_id,
        session_speaker_id: u.speaker_id ? (speakerLabelToId.get(u.speaker_id) ?? null) : null,
        is_user: false,
        start_sec: u.start_sec,
        end_sec: u.end_sec,
        duration_sec: u.duration_sec,
        storage_path: storagePath,
        file_size_bytes: wavBuffer.byteLength,
        upload_status: 'uploaded',
        transcript_text: u.transcript_text,
        transcript_words: u.words ?? null,
        segmented_by: 'gpu_v10',
        client_version: 'gpu-worker-2.0',
        quality_score: utteranceQualityScore,
        quality_grade: utteranceQualityGrade,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'session_id,sequence_order' },
    )
    if (error) {
      throw new Error(`utterance INSERT failed (${utteranceId}): ${error.message}`)
    }
  }

  // ── STAGE 16: session_segments ─────────────────────────────────────
  const topicSegmentsData = result.topic_segments ?? []
  const segmentIndexToId = new Map<number, string>()
  for (const seg of topicSegmentsData) {
    const { data: segData, error: segErr } = await supabaseAdmin
      .from('session_segments')
      .upsert(
        {
          session_id: session.id,
          segment_index: seg.segment_index,
          topic: seg.topic ?? null,
          start_ms: seg.start_ms ?? null,
          end_ms: seg.end_ms ?? null,
          utterance_count: seg.utterance_indices.length,
        },
        { onConflict: 'session_id,segment_index' },
      )
      .select('id')
      .single()
    if (segErr) {
      console.warn(
        `[gpu-worker] session_segments upsert failed (${seg.segment_index}): ${segErr.message}`,
      )
    } else if (segData) {
      segmentIndexToId.set(seg.segment_index, segData.id)
    }
  }
  for (const seg of topicSegmentsData) {
    const segId = segmentIndexToId.get(seg.segment_index)
    if (!segId) continue
    for (const uttIdx of seg.utterance_indices) {
      const uttSeq = uttIdx + 1
      const uttSegId = `utt_${session.id}_${String(uttSeq).padStart(3, '0')}`
      const { error: updErr } = await supabaseAdmin
        .from('utterances')
        .update({ segment_id: segId })
        .eq('id', uttSegId)
      if (updErr) {
        console.warn(
          `[gpu-worker] utterances.segment_id update failed (${uttSegId}): ${updErr.message}`,
        )
      }
    }
  }

  // 전처리된 오디오로 S3 raw_audio_url 덮어쓰기 — startSec/endSec 가 재생 위치와 일치하게 됨.
  // voice API 가 silence-compress 후 WhisperX 를 돌리므로, 발화 타임스탬프는
  // 압축된 오디오 기준이다. _preprocessed_audio.wav 를 원본 위치에 덮어써서 맞춘다.
  try {
    const preprocessedBuf = await downloadUtteranceWav(taskId, '_preprocessed_audio.wav')
    await uploadObject(
      S3_AUDIO_BUCKET,
      session.raw_audio_url,
      new Uint8Array(preprocessedBuf),
      'audio/wav',
    )
    console.log(
      `[gpu-worker] session=${session.id}: preprocessed audio (${preprocessedBuf.byteLength} bytes) overwrote ${session.raw_audio_url}`,
    )
  } catch (err: any) {
    // 청크 모드(1h 이상 오디오)에서는 _preprocessed_audio.wav 가 생성되지 않음 — 무시.
    console.warn(
      `[gpu-worker] session=${session.id}: preprocessed audio overwrite skipped — ${err.message}`,
    )
  }

  const { data: qualityRows } = await supabaseAdmin
    .from('utterances')
    .select('quality_score')
    .eq('session_id', session.id)
    .not('quality_score', 'is', null)
    .limit(1)
  const qualityComputed = (qualityRows?.length ?? 0) > 0

  const now = new Date().toISOString()
  await supabaseAdmin
    .from('sessions')
    .update({
      gpu_upload_status: 'done',
      stt_status: 'done',
      stt_at: now,
      diarize_status: 'done',
      diarize_at: now,
      gpu_pii_status: 'done',
      gpu_pii_at: now,
      auto_label_status: 'done',
      quality_status: qualityComputed ? 'done' : 'skipped',
      quality_at: now,
      utterance_count: utterances.length,
      gpu_last_error: null, // 성공 시 에러 메시지 클리어
    })
    .eq('id', session.id)
}

// ── 메인 처리 함수 ──────────────────────────────────────────────────
// prefetched: 이전 iteration 에서 미리 submit 해 둔 세션 (없으면 null)
export async function processOneSession(prefetched: PrefetchResult | null = null): Promise<{
  processed: boolean
  backoff503: boolean
  nextPrefetched: PrefetchResult | null
}> {
  // stuck sweep + segment backfill — 5분마다 한 번씩만
  if (Date.now() - lastStuckSweepAt > STUCK_SWEEP_INTERVAL_MS) {
    await sweepStuckSessions()
    await sweepSegmentBackfill()
    lastStuckSweepAt = Date.now()
  }

  // prefetched 세션이 있으면 그걸 사용, 없으면 새로 픽업
  let session: { id: string; user_id: string; raw_audio_url: string; isRetry: boolean; consent_status?: string; gpu_last_error?: string | null } | null
  let taskId: string | null = null

  if (prefetched) {
    session = prefetched.session
    taskId = prefetched.taskId
    // stuck sweep 오탐 방지: pre-fetch 시 claim 시점이 아닌 실제 폴링 시작 시점으로 리셋
    await supabaseAdmin
      .from('sessions')
      .update({ gpu_started_at: new Date().toISOString() })
      .eq('id', session.id)
    console.log(
      `[gpu-worker] using prefetched session=${session.id} task_id=${taskId}`,
    )
  } else {
    session = await pickNextSession()
    if (!session) return { processed: false, backoff503: false, nextPrefetched: null }
  }

  const startedAt = Date.now()
  console.log(
    `[gpu-worker] picked session=${session.id} url=${session.raw_audio_url}${session.isRetry ? ' (retry)' : ''}`,
  )

  // pre-fetch 시작: 현재 세션의 GPU poll 대기 시간에 다음 세션 준비
  // prefetched 세션을 방금 꺼냈으니 이제 그 다음 세션을 pre-fetch
  const prefetchPromise = prefetchNextSession(session.id)

  // S3 업로드(다운로드) 완료 여부 추적 — 에러 시 실제 파일 존재 여부로 상태 결정
  let audioDownloaded = prefetched !== null  // prefetch 경로는 이미 다운로드 완료

  try {
    if (!taskId) {
      // prefetch 없이 직접 진입한 경우 — 직접 다운로드 + submit
      const ext = (session.raw_audio_url.split('.').pop() ?? 'm4a').toLowerCase()
      const audioBuffer = await downloadRawAudio(session.raw_audio_url)
      audioDownloaded = true
      console.log(
        `[gpu-worker] downloaded ${audioBuffer.byteLength} bytes from ${session.raw_audio_url}`,
      )
      taskId = await submitToVoiceApi(audioBuffer, ext)
      console.log(`[gpu-worker] voice_api task_id=${taskId}`)
    }

    // GPU poll (1-10+ 분) — 이 대기 중에 prefetchPromise 가 병렬 실행
    const result = await pollVoiceApiJob(taskId)
    if (result.status === 'failed') {
      throw new Error(`voice_api job failed: ${result.error ?? 'unknown'}`)
    }

    if (result.speakers && result.speakers.length > 0) {
      result.speakers = await enrichSpeakersWithRole(result.speakers, session.user_id)
    }

    await persistResults(session, taskId, result)
    console.log(
      `[gpu-worker] session=${session.id} done — utterances=${result.utterances?.length ?? 0}, ms=${Date.now() - startedAt}`,
    )

    // Feature 3: both_agreed + 화자 1명 + 발화 6개 이상 → pyannote 실패 의심, 재처리
    const uttCount = result.utterances?.length ?? 0
    if (
      session.consent_status === 'both_agreed' &&
      uttCount >= 6 &&
      !(session.gpu_last_error ?? '').startsWith('SPEAKER_REQUEUE:')
    ) {
      const { count: spCount, error: spErr } = await supabaseAdmin
        .from('session_speakers')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', session.id)
      if (!spErr && spCount === 1) {
        console.warn(
          `[gpu-worker] session=${session.id} both_agreed+1speaker+${uttCount}utts — pyannote 실패 의심, 재처리 큐 진입`,
        )
        await supabaseAdmin
          .from('sessions')
          .update({
            gpu_upload_status: 'pending',
            gpu_started_at: null,
            gpu_retry_count: 0,
            gpu_last_error: `SPEAKER_REQUEUE: both_agreed+1speaker+${uttCount}utts`,
          })
          .eq('id', session.id)
        const nextPrefetched = await prefetchPromise
        return { processed: true, backoff503: false, nextPrefetched }
      }
    }

    const nextPrefetched = await prefetchPromise
    return { processed: true, backoff503: false, nextPrefetched }
  } catch (err: any) {
    // prefetch 결과는 실패해도 항상 회수 — 이미 submit 된 job 은 다음 iteration 에서 poll
    const nextPrefetched = await prefetchPromise.catch(() => null)

    if (err instanceof Voice503Error) {
      // 503 — pending 으로 되돌리고 backoff. retry_count 안 올림.
      console.warn(`[gpu-worker] session=${session.id} 503 — revert to pending, backoff`)
      await supabaseAdmin
        .from('sessions')
        .update({
          gpu_upload_status: 'pending',
          gpu_started_at: null,
          gpu_last_error: err.message,
        })
        .eq('id', session.id)
      return { processed: false, backoff503: true, nextPrefetched }
    }

    // 일반 실패: retry_count++ 처리
    // err.cause 도 캡쳐 (undici 의 'fetch failed' 같은 generic 메시지에서 진짜 원인 추출)
    const causeMsg = err?.cause
      ? ` cause=${err.cause?.code ?? ''} ${err.cause?.message ?? String(err.cause)}`
      : ''
    const fullErrMsg = `${err.message ?? String(err)}${causeMsg}`
    console.error(`[gpu-worker] session=${session.id} FAIL: ${fullErrMsg}`)

    // 오디오 다운로드가 이미 완료된 경우 → S3 에 파일이 있음 → pending 재시도 (업로드 실패 아님)
    // 다운로드 전 실패 → 파일 미존재 가능 → S3 재확인 후 상태 결정
    let nextUploadStatus: 'pending' | 'failed' = 'failed'
    if (audioDownloaded) {
      nextUploadStatus = 'pending'
    } else {
      // 다운로드 시도 전 실패 — S3 에서 직접 확인
      try {
        const exists = await objectExists(S3_AUDIO_BUCKET, session.raw_audio_url)
        if (exists) nextUploadStatus = 'pending'
      } catch {
        // S3 확인 실패 시 failed 유지 (보수적)
      }
    }

    const { error: updateErr } = await supabaseAdmin.rpc('increment_gpu_retry', {
      p_session_id: session.id,
      p_error_msg: fullErrMsg.slice(0, 1000),
    })
    if (updateErr) {
      // RPC 미존재 시 fallback — 직접 SELECT + UPDATE (updated_at 명시 — 30분 retry 간격 적용)
      const { data: row } = await supabaseAdmin
        .from('sessions')
        .select('gpu_retry_count')
        .eq('id', session.id)
        .single()
      const nextCount = (row?.gpu_retry_count ?? 0) + 1
      await supabaseAdmin
        .from('sessions')
        .update({
          gpu_upload_status: nextUploadStatus,
          gpu_retry_count: nextCount,
          gpu_last_error: fullErrMsg.slice(0, 1000),
          updated_at: new Date().toISOString(),
        })
        .eq('id', session.id)
    }
    return { processed: true, backoff503: false, nextPrefetched }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── 폴링 루프 (cancellable sleep + concurrency-aware + pre-fetch) ────
// 동작:
//   1. processOneSession(prefetched) — 한 건 픽업/처리 시도
//      - prefetched 있으면 → 이미 submit 된 job poll (S3/submit 시간 제거)
//      - prefetched 없으면 → 신규 픽업 후 S3 다운로드 + submit + poll
//   2. poll 대기 중 prefetchNextSession() 병렬 실행 → nextPrefetched 보관
//   3. 처리됨 → 즉시 다음 iteration (nextPrefetched 전달)
//   4. 큐 비어있음 → POLL_INTERVAL_MS 또는 wakeup 중 빠른 쪽
//   5. 503 → POLL_BACKOFF_503_MS 만큼 sleep (wakeup 무시 — voice_api 큐 만석 존중)
async function pollLoop(workerIndex: number): Promise<void> {
  const tag = `[gpu-worker#${workerIndex}]`
  console.log(`${tag} loop started`)
  let prefetched: PrefetchResult | null = null
  while (!isShuttingDown) {
    try {
      const { processed, backoff503, nextPrefetched } = await processOneSession(prefetched)
      prefetched = nextPrefetched
      if (backoff503) {
        // 503 — voice_api 큐 만석. wakeup 무시하고 통째로 sleep.
        prefetched = null  // 503 backoff 중에는 pre-fetch 결과를 버림 (오래된 job 이 될 수 있음)
        await sleep(POLL_BACKOFF_503_MS)
      } else if (!processed) {
        // 큐 비어있음 — 30초 대기, 단 wakeup 시그널 오면 즉시 다시 시도
        await Promise.race([sleep(POLL_INTERVAL_MS), getWakeup().promise])
      }
      // processed=true → 즉시 다음 픽업 (nextPrefetched 전달)
    } catch (err: any) {
      console.error(`${tag} pollLoop error:`, err.message)
      prefetched = null
      await sleep(POLL_INTERVAL_MS)
    }
  }
  console.log(`${tag} shutdown complete`)
}

// ── 시작/정지 export ───────────────────────────────────────────────
export function startGpuWorker(): void {
  console.log(
    `[gpu-worker] starting v3 — VOICE_API_URL=${VOICE_API_URL}, concurrency=${WORKER_CONCURRENCY}, poll=${POLL_INTERVAL_MS}ms (safety net), stuck=${STUCK_THRESHOLD_MS / 60000}min, retry=${MAX_RETRY_COUNT}x@${RETRY_DELAY_MIN}min`,
  )
  for (let i = 0; i < WORKER_CONCURRENCY; i++) {
    pollLoop(i).catch((err) => {
      console.error(`[gpu-worker#${i}] FATAL pollLoop crashed:`, err)
    })
  }
}

export function stopGpuWorker(): void {
  console.log('[gpu-worker] stop requested')
  isShuttingDown = true
  // wakeup 도 깨워서 sleep 중인 loop 들이 즉시 종료 체크 하도록
  getWakeup().resolve()
}

// ── 모니터링 export — admin endpoint 용 ───────────────────────────
export async function getWorkerStatus(): Promise<{
  voiceApiUrl: string
  pollIntervalMs: number
  concurrency: number
  retryConfig: { maxCount: number; delayMin: number; stuckMin: number }
  queue: {
    pending: number
    running: number
    failed: number
    failedRetryEligible: number
    failedExhausted: number
    done: number
    noAudio: number
  }
  recentFailures: { id: string; gpu_last_error: string; gpu_retry_count: number; updated_at: string }[]
  oldestPending: { id: string; raw_audio_uploaded_at: string } | null
  currentRunning: { id: string; gpu_started_at: string } | null
}> {
  const retryCutoff = new Date(Date.now() - RETRY_DELAY_MIN * 60_000).toISOString()

  const [
    pendingCount,
    noAudioCount,
    runningCount,
    failedCount,
    failedRetryEligibleCount,
    failedExhaustedCount,
    doneCount,
    recentFailures,
    oldestPending,
    currentRunning,
  ] = await Promise.all([
    supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('gpu_upload_status', 'pending')
      .not('raw_audio_url', 'is', null),
    supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('gpu_upload_status', 'pending')
      .is('raw_audio_url', null),
    supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('gpu_upload_status', 'running'),
    supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('gpu_upload_status', 'failed'),
    supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('gpu_upload_status', 'failed')
      .lt('gpu_retry_count', MAX_RETRY_COUNT)
      .lt('updated_at', retryCutoff),
    supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('gpu_upload_status', 'failed')
      .gte('gpu_retry_count', MAX_RETRY_COUNT),
    supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('gpu_upload_status', 'done'),
    supabaseAdmin
      .from('sessions')
      .select('id, gpu_last_error, gpu_retry_count, updated_at')
      .eq('gpu_upload_status', 'failed')
      .order('updated_at', { ascending: false })
      .limit(5),
    supabaseAdmin
      .from('sessions')
      .select('id, raw_audio_uploaded_at')
      .eq('gpu_upload_status', 'pending')
      .not('raw_audio_url', 'is', null)
      .order('raw_audio_uploaded_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('sessions')
      .select('id, gpu_started_at')
      .eq('gpu_upload_status', 'running')
      .order('gpu_started_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ])

  return {
    voiceApiUrl: VOICE_API_URL,
    pollIntervalMs: POLL_INTERVAL_MS,
    concurrency: WORKER_CONCURRENCY,
    retryConfig: {
      maxCount: MAX_RETRY_COUNT,
      delayMin: RETRY_DELAY_MIN,
      stuckMin: STUCK_THRESHOLD_MS / 60_000,
    },
    queue: {
      pending: pendingCount.count ?? 0,
      noAudio: noAudioCount.count ?? 0,
      running: runningCount.count ?? 0,
      failed: failedCount.count ?? 0,
      failedRetryEligible: failedRetryEligibleCount.count ?? 0,
      failedExhausted: failedExhaustedCount.count ?? 0,
      done: doneCount.count ?? 0,
    },
    recentFailures: (recentFailures.data ?? []) as any,
    oldestPending: (oldestPending.data ?? null) as any,
    currentRunning: (currentRunning.data ?? null) as any,
  }
}
