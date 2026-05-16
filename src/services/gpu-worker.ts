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
import { s3Client, S3_AUDIO_BUCKET, uploadObject } from '../lib/s3.js'
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
  session: { id: string; user_id: string; raw_audio_url: string; isRetry: boolean }
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

// ── stuck sweep — running 10분 초과 → failed 강제 전환 ────────────
async function sweepStuckSessions(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString()
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .update({
      gpu_upload_status: 'failed',
      gpu_last_error: 'stuck — running 10분 초과 (워커 사망 또는 hang). 자동 재시도 큐에 진입.',
    })
    .eq('gpu_upload_status', 'running')
    .lt('gpu_started_at', cutoff)
    .select('id')

  if (error) {
    console.error('[gpu-worker] sweepStuck error:', error.message)
    return
  }
  if (data && data.length > 0) {
    console.warn(`[gpu-worker] sweepStuck: ${data.length} stuck session(s) reset to failed`)
  }
}

// ── pickup: 신규 pending OR failed 재시도 ────────────────────────────
async function pickNextSession(): Promise<{
  id: string
  user_id: string
  raw_audio_url: string
  isRetry: boolean
} | null> {
  // 우선순위 1: 신규 pending
  const { data: pendingRow, error: pendingErr } = await supabaseAdmin
    .from('sessions')
    .select('id, user_id, raw_audio_url')
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
    .select('id, user_id, raw_audio_url, gpu_retry_count')
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
        quality_status: 'failed',
        utterance_count: 0,
        gpu_last_error: 'voice_api_0_utterances',
      })
      .eq('id', session.id)
    return
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
  // stuck sweep — 5분마다 한 번씩만
  if (Date.now() - lastStuckSweepAt > STUCK_SWEEP_INTERVAL_MS) {
    await sweepStuckSessions()
    lastStuckSweepAt = Date.now()
  }

  // prefetched 세션이 있으면 그걸 사용, 없으면 새로 픽업
  let session: { id: string; user_id: string; raw_audio_url: string; isRetry: boolean } | null
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

  try {
    if (!taskId) {
      // prefetch 없이 직접 진입한 경우 — 직접 다운로드 + submit
      const ext = (session.raw_audio_url.split('.').pop() ?? 'm4a').toLowerCase()
      const audioBuffer = await downloadRawAudio(session.raw_audio_url)
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

    await persistResults(session, taskId, result)
    console.log(
      `[gpu-worker] session=${session.id} done — utterances=${result.utterances?.length ?? 0}, ms=${Date.now() - startedAt}`,
    )

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

    // 일반 실패: failed + retry_count++
    // err.cause 도 캡쳐 (undici 의 'fetch failed' 같은 generic 메시지에서 진짜 원인 추출)
    const causeMsg = err?.cause
      ? ` cause=${err.cause?.code ?? ''} ${err.cause?.message ?? String(err.cause)}`
      : ''
    const fullErrMsg = `${err.message ?? String(err)}${causeMsg}`
    console.error(`[gpu-worker] session=${session.id} FAIL: ${fullErrMsg}`)

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
          gpu_upload_status: 'failed',
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
