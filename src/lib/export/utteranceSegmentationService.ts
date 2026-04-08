// ── Utterance Segmentation Service ─────────────────────────────────────
// 세션 WAV를 5~30초 utterance 단위로 분할하는 서버사이드 엔진.
// FFmpeg silencedetect → 묵음 경계 기준 분할 → 5초 미만 병합, 30��� 초과 재분할.

import { mkdirSync, rmSync, existsSync, createWriteStream } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { s3Client, S3_AUDIO_BUCKET, uploadObject } from '../s3.js'
import {
  detectSilenceBoundaries,
  extractSegment,
  processAudio,
} from '../audio/ffmpegProcessor.js'
import { mergeShortSegments, splitLongSegments } from './segmentationUtils.js'
import { buildUtteranceId } from './utteranceRepository.js'
import { supabaseAdmin } from '../supabase.js'

const MIN_UTTERANCE_SEC = 5
const MAX_UTTERANCE_SEC = 30

export interface SegmentationOptions {
  silenceThreshold?: string   // default '-40dB'
  minSilenceDuration?: number // default 0.5s
  noiseReduction?: number     // default 20
  consentMode?: 'all' | 'user_only'
}

export interface UtteranceSegment {
  utteranceId: string
  utteranceIndex: number
  startSec: number
  endSec: number
  durationSec: number
  storagePath: string
  fileSizeBytes: number
  excluded: boolean
}

export interface SegmentationResult {
  sessionId: string
  totalUtterances: number
  activeUtterances: number
  segments: UtteranceSegment[]
  source?: 'client' | 'server'
}

/**
 * Segment a session WAV from S3 into utterances.
 * 1. Download WAV from S3
 * 2. Preprocess (noise reduction + normalization)
 * 3. Detect silence boundaries
 * 4. Merge short segments (<5s), split long segments (>30s)
 * 5. Extract individual utterance WAVs
 * 6. Upload utterance WAVs to S3
 *
 * consent 'user_only': Phase 1에서는 diarization 미지원 → 전체 포함 (excluded=false)
 */
export async function segmentSession(
  sessionId: string,
  audioStoragePath: string,
  options?: SegmentationOptions,
): Promise<SegmentationResult> {
  // v3: 클라이언트 업로드 발화가 존재하면 서버 분할 스킵
  const { count } = await supabaseAdmin
    .from('utterances')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('upload_status', 'uploaded')

  if (count && count > 0) {
    return { sessionId, totalUtterances: count, activeUtterances: count, segments: [], source: 'client' }
  }

  // 레거시 폴백: FFmpeg 서버 분할
  const workDir = join(tmpdir(), `utt-seg-${randomUUID()}`)
  mkdirSync(workDir, { recursive: true })

  try {
    // 1. Download WAV from S3
    const rawPath = join(workDir, 'raw.wav')
    await downloadFromS3(S3_AUDIO_BUCKET, audioStoragePath, rawPath)

    // 2. Preprocess
    const processedPath = join(workDir, 'processed.wav')
    await processAudio(rawPath, processedPath, {
      noiseReduction: options?.noiseReduction ?? 20,
    })

    // 3. Detect silence boundaries
    const rawBoundaries = await detectSilenceBoundaries(processedPath, {
      silenceThreshold: options?.silenceThreshold ?? '-40dB',
      minSilenceDuration: options?.minSilenceDuration ?? 0.5,
    })

    // 4. Merge short + split long
    const merged = mergeShortSegments(rawBoundaries, MIN_UTTERANCE_SEC)
    const final = splitLongSegments(merged, MAX_UTTERANCE_SEC)

    // 5 & 6. Extract and upload each utterance
    const segments: UtteranceSegment[] = []

    for (let i = 0; i < final.length; i++) {
      const { start, end } = final[i]
      const durationSec = Math.round((end - start) * 100) / 100
      const utteranceId = buildUtteranceId(sessionId, i)
      const uttFileName = `${utteranceId}.wav`
      const localPath = join(workDir, uttFileName)

      await extractSegment(processedPath, localPath, start, end)

      const fileSizeBytes = (await stat(localPath)).size

      const s3Key = buildUtteranceS3Key(sessionId, utteranceId)
      const wavBuffer = await readFileAsBuffer(localPath)
      await uploadObject(S3_AUDIO_BUCKET, s3Key, wavBuffer, 'audio/wav')

      segments.push({
        utteranceId,
        utteranceIndex: i,
        startSec: Math.round(start * 100) / 100,
        endSec: Math.round(end * 100) / 100,
        durationSec,
        storagePath: s3Key,
        fileSizeBytes,
        excluded: false,
      })
    }

    return {
      sessionId,
      totalUtterances: segments.length,
      activeUtterances: segments.filter((s) => !s.excluded).length,
      segments,
    }
  } finally {
    if (existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true })
    }
  }
}

/**
 * Segment multiple sessions in sequence.
 * Returns results for each session; failed sessions are included with error info.
 */
export async function segmentBulk(
  sessions: Array<{ sessionId: string; audioStoragePath: string }>,
  options?: SegmentationOptions,
): Promise<Array<{ sessionId: string; result?: SegmentationResult; error?: string }>> {
  const results: Array<{ sessionId: string; result?: SegmentationResult; error?: string }> = []

  for (const { sessionId, audioStoragePath } of sessions) {
    try {
      const result = await segmentSession(sessionId, audioStoragePath, options)
      results.push({ sessionId, result })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : ''
      console.error(`segmentBulk failed for session ${sessionId}:`, message)
      if (stack) console.error(stack)
      results.push({ sessionId, error: message })
    }
  }

  return results
}

/** Build S3 key for an utterance WAV */
function buildUtteranceS3Key(sessionId: string, utteranceId: string): string {
  return `utterances/${sessionId}/${utteranceId}.wav`
}

/** Download an object from S3 to local filesystem */
async function downloadFromS3(
  bucket: string,
  key: string,
  destPath: string,
): Promise<void> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  )

  if (!response.Body) {
    throw new Error(`S3 object body is empty: ${key}`)
  }

  const readable = response.Body as Readable
  const writable = createWriteStream(destPath)
  await pipeline(readable, writable)
}

/** Read a local file into a Buffer */
async function readFileAsBuffer(filePath: string): Promise<Buffer> {
  const { readFile } = await import('fs/promises')
  return readFile(filePath)
}
