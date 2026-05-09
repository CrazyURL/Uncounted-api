// ════════════════════════════════════════════════════════════════════
// BM v10 — GPU 처리 워커 (백그라운드 폴링)
// ════════════════════════════════════════════════════════════════════
//
// WHY
//   App 이 raw audio 를 iwinv S3 에 업로드 → sessions.raw_audio_url 채워짐.
//   본 워커가 30초마다 폴링하여 1건씩 voice_api 로 전달, 결과를 DB+S3 에 반영.
//
// 흐름 (1 trace)
//   1. SELECT FOR UPDATE SKIP LOCKED — raw_audio_url IS NOT NULL AND status='pending'
//   2. status='running' (singleton lock)
//   3. iwinv S3 에서 raw audio 다운로드
//   4. voice_api POST /api/v1/transcribe (multipart, diarize+split+pii+denoise)
//   5. voice_api GET /api/v1/jobs/{task_id} 폴링 (1초 간격, max 5분)
//   6. utterances 분리 결과:
//      - voice_api GET /jobs/{task_id}/audio/{filename} 으로 WAV 다운로드
//      - iwinv S3 utterances/{sessionId}/utt_{sessionId}_{seq:003}.wav 업로드
//      - utterances 테이블 INSERT
//   7. sessions UPDATE: stt_status, diarize_status, gpu_pii_status, quality_status = 'done'
//
// 단일 인스턴스 보장 (Render auto-scale 시):
//   GPU_WORKER_ENABLED=true 환경변수 설정한 인스턴스만 워커 시작.
//   추가 안전장치는 DB-level SKIP LOCKED.
//
// 시작:
//   src/index.ts 에서 if (process.env.GPU_WORKER_ENABLED === 'true') startGpuWorker()
//
// STAGE 2 에서 추가 예정:
//   - 재시도 로직 (gpu_retry_count, max 3)
//   - 워커 사망 감지 (running 상태 10분 초과 시 stuck → failed 강제전환)
//   - voice_api 503 backoff
//   - 30일 lifecycle 자동 삭제
// ════════════════════════════════════════════════════════════════════

import { GetObjectCommand } from '@aws-sdk/client-s3'
import { supabaseAdmin } from '../lib/supabase.js'
import { s3Client, S3_AUDIO_BUCKET, uploadObject } from '../lib/s3.js'

const POLL_INTERVAL_MS = 30_000  // 30초마다 폴링
const VOICE_API_URL = process.env.VOICE_API_URL ?? 'http://localhost:8001'
const VOICE_API_POLL_INTERVAL_MS = 1_000   // task_id 폴링 1초 간격
const VOICE_API_MAX_WAIT_MS = 5 * 60 * 1000 // 한 건당 최대 5분

let isShuttingDown = false

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

// ── 1. 다음 처리할 세션 1건 picking (SKIP LOCKED) ──────────────────
async function pickNextSession(): Promise<{
  id: string
  user_id: string
  raw_audio_url: string
} | null> {
  // PostgREST 가 SKIP LOCKED 를 직접 지원 안 하므로 RPC 또는 단순 SELECT+UPDATE.
  // STAGE 1 단순화: 단일 인스턴스 가정 → 단순 SELECT + UPDATE.
  // (Render service 인스턴스 1개 강제 + GPU_WORKER_ENABLED 1개만 true → 충돌 없음)
  // STAGE 2 에서 advisory lock 또는 RPC 로 강화.
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('id, user_id, raw_audio_url')
    .eq('gpu_upload_status', 'pending')
    .not('raw_audio_url', 'is', null)
    .order('raw_audio_uploaded_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[gpu-worker] pickNextSession error:', error.message)
    return null
  }
  if (!data) return null

  // 'running' 마킹 (다른 인스턴스/재시도 로직과의 race 최소화)
  const { error: updateError, count } = await supabaseAdmin
    .from('sessions')
    .update({
      gpu_upload_status: 'running',
      gpu_uploaded_at: new Date().toISOString(),
    }, { count: 'exact' })
    .eq('id', data.id)
    .eq('gpu_upload_status', 'pending')

  if (updateError || !count || count === 0) {
    // 다른 인스턴스가 먼저 픽업 또는 상태 변경됨 — skip
    return null
  }

  return data as { id: string; user_id: string; raw_audio_url: string }
}

// ── 2. iwinv S3 에서 raw audio 다운로드 ────────────────────────────
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

// ── 3. voice_api POST /api/v1/transcribe ───────────────────────────
async function submitToVoiceApi(audioBuffer: Buffer, ext: string): Promise<string> {
  const url =
    `${VOICE_API_URL}/api/v1/transcribe` +
    `?language=ko&diarize=true&split_by_utterance=true&mask_pii=true&denoise=true`

  const blob = new Blob([audioBuffer], { type: 'application/octet-stream' })
  const form = new FormData()
  form.append('file', blob, `raw.${ext}`)

  const res = await fetch(url, { method: 'POST', body: form })
  if (res.status === 503) {
    throw new Error('voice_api queue full (503) — backoff and retry next tick')
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`voice_api transcribe failed: ${res.status} ${text.slice(0, 200)}`)
  }
  const json = (await res.json()) as { task_id: string; status: string }
  return json.task_id
}

// ── 4. voice_api job 폴링 ───────────────────────────────────────────
async function pollVoiceApiJob(taskId: string): Promise<VoiceApiJobResult> {
  const start = Date.now()
  while (Date.now() - start < VOICE_API_MAX_WAIT_MS) {
    const res = await fetch(`${VOICE_API_URL}/api/v1/jobs/${taskId}`)
    if (res.status === 500) {
      // failed
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

// ── 5. utterance WAV 다운로드 (voice_api → iwinv S3) ───────────────
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

// ── 6. utterances INSERT + sessions UPDATE 'done' ──────────────────
async function persistResults(
  session: { id: string; user_id: string },
  taskId: string,
  result: VoiceApiJobResult,
): Promise<void> {
  const utterances = result.utterances ?? []
  if (utterances.length === 0) {
    console.warn(`[gpu-worker] session ${session.id}: 0 utterances returned`)
  }

  // utterance 별로 WAV 다운로드 → iwinv 업로드 → DB INSERT
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i]
    const seq = i + 1 // 1-based
    const seqPadded = String(seq).padStart(3, '0')
    const utteranceId = `utt_${session.id}_${seqPadded}`
    const storagePath = `utterances/${session.id}/${utteranceId}.wav`

    const wavBuffer = await downloadUtteranceWav(taskId, u.audio_filename)
    await uploadObject(S3_AUDIO_BUCKET, storagePath, new Uint8Array(wavBuffer), 'audio/wav')

    const { error } = await supabaseAdmin.from('utterances').upsert(
      {
        id: utteranceId,
        session_id: session.id,
        chunk_id: null,
        user_id: session.user_id,
        sequence_in_chunk: seq,
        sequence_order: seq,
        speaker_id: u.speaker_id,
        is_user: false, // STAGE 2 에서 voice_profile 매칭으로 보강
        start_sec: u.start_sec,
        end_sec: u.end_sec,
        duration_sec: u.duration_sec,
        storage_path: storagePath,
        file_size_bytes: wavBuffer.byteLength,
        upload_status: 'uploaded',
        transcript_text: u.transcript_text,
        transcript_words: u.words ?? null,
        segmented_by: 'gpu_v10',
        client_version: 'gpu-worker-1.0',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'session_id,sequence_order' },
    )
    if (error) {
      throw new Error(`utterance INSERT failed (${utteranceId}): ${error.message}`)
    }
  }

  // sessions 5단계 done 으로 마킹
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
      quality_status: 'done',
      quality_at: now,
      utterance_count: utterances.length,
    })
    .eq('id', session.id)
}

// ── 메인 처리 함수 (export — E2E 테스트용) ──────────────────────────
export async function processOneSession(): Promise<boolean> {
  const session = await pickNextSession()
  if (!session) return false

  const startedAt = Date.now()
  console.log(`[gpu-worker] picked session=${session.id} url=${session.raw_audio_url}`)

  try {
    // ext 추출 (raw-audio/{userId}/{sessionId}.{ext})
    const ext = (session.raw_audio_url.split('.').pop() ?? 'm4a').toLowerCase()

    const audioBuffer = await downloadRawAudio(session.raw_audio_url)
    console.log(
      `[gpu-worker] downloaded ${audioBuffer.byteLength} bytes from ${session.raw_audio_url}`,
    )

    const taskId = await submitToVoiceApi(audioBuffer, ext)
    console.log(`[gpu-worker] voice_api task_id=${taskId}`)

    const result = await pollVoiceApiJob(taskId)
    if (result.status === 'failed') {
      throw new Error(`voice_api job failed: ${result.error ?? 'unknown'}`)
    }

    await persistResults(session, taskId, result)
    console.log(
      `[gpu-worker] session=${session.id} done — utterances=${result.utterances?.length ?? 0}, ms=${Date.now() - startedAt}`,
    )
    return true
  } catch (err: any) {
    console.error(`[gpu-worker] session=${session.id} FAIL:`, err.message)
    // 실패 마킹 — STAGE 2 에서 retry 로직 추가
    await supabaseAdmin
      .from('sessions')
      .update({
        gpu_upload_status: 'failed',
        // STAGE 2 컬럼 (gpu_last_error) 은 아직 없음 — 로그만으로 충분
      })
      .eq('id', session.id)
    return true // 큐는 계속 진행 (다른 세션 처리 가능)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── 폴링 루프 ───────────────────────────────────────────────────────
async function pollLoop(): Promise<void> {
  while (!isShuttingDown) {
    try {
      const processed = await processOneSession()
      if (!processed) {
        // 큐 빈 경우만 대기. 처리한 경우 곧바로 다음 1건 시도.
        await sleep(POLL_INTERVAL_MS)
      }
    } catch (err: any) {
      console.error('[gpu-worker] pollLoop error:', err.message)
      await sleep(POLL_INTERVAL_MS)
    }
  }
  console.log('[gpu-worker] shutdown complete')
}

// ── 시작/정지 export ───────────────────────────────────────────────
export function startGpuWorker(): void {
  console.log(
    `[gpu-worker] starting — VOICE_API_URL=${VOICE_API_URL}, poll=${POLL_INTERVAL_MS}ms`,
  )
  pollLoop().catch((err) => {
    console.error('[gpu-worker] FATAL pollLoop crashed:', err)
  })
}

export function stopGpuWorker(): void {
  console.log('[gpu-worker] stop requested')
  isShuttingDown = true
}
