// ── PII Mask Sync Verification Service ──────────────────────────────────
// transcript [MASKED] 토큰과 오디오 beep(1kHz) 구간의 정합성을 검증한다.
// 불일치 시 syncStatus: 'mismatch' 반환 (자동 보정은 Phase 2).

import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, unlink, mkdir } from 'fs/promises'
import { s3Client, S3_AUDIO_BUCKET } from '../s3.js'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { supabaseAdmin } from '../supabase.js'
import { detectSilenceBoundaries } from '../audio/ffmpegProcessor.js'
import ffmpeg from 'fluent-ffmpeg'

// ── Types ───────────────────────────────────────────────────────────────

export interface TranscriptWord {
  word: string
  start: number  // chunk-relative seconds
  end: number
  probability?: number
}

export interface MaskedInterval {
  startSec: number  // absolute seconds (within full audio)
  endSec: number
  chunkIndex: number
  word: string
}

export interface BeepInterval {
  startSec: number
  endSec: number
}

export type SyncStatus = 'synced' | 'mismatch' | 'no_masks' | 'error'

export interface MaskSyncResult {
  sessionId: string
  syncStatus: SyncStatus
  maskedIntervals: MaskedInterval[]
  beepIntervals: BeepInterval[]
  mismatches: MaskMismatch[]
  summary: string
}

export interface MaskMismatch {
  type: 'mask_without_beep' | 'beep_without_mask'
  interval: { startSec: number; endSec: number }
  detail: string
}

// ── Constants ───────────────────────────────────────────────────────────

const BEEP_FREQ = 1000       // 1kHz beep frequency
const TOLERANCE_SEC = 0.15   // 150ms tolerance for alignment
const BANDPASS_LOW = 900     // Hz
const BANDPASS_HIGH = 1100   // Hz

// ── Helpers ─────────────────────────────────────────────────────────────

async function downloadToTemp(s3Key: string): Promise<string> {
  const tempDir = join(tmpdir(), 'uncounted-pii-sync')
  await mkdir(tempDir, { recursive: true })

  const tempPath = join(tempDir, `${Date.now()}_${Math.random().toString(36).slice(2)}.wav`)

  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: S3_AUDIO_BUCKET, Key: s3Key }),
  )

  if (!response.Body) {
    throw new Error(`Empty S3 response for key: ${s3Key}`)
  }

  const bytes = await response.Body.transformToByteArray()
  await writeFile(tempPath, bytes)
  return tempPath
}

async function cleanupTemp(path: string): Promise<void> {
  try { await unlink(path) } catch { /* ignore */ }
}

/**
 * Detect beep (1kHz tone) intervals in audio using bandpass filter + energy detection.
 * Strategy: bandpass around 1kHz → detect non-silent segments → those are beep regions.
 */
async function detectBeepIntervals(wavPath: string): Promise<BeepInterval[]> {
  const tempFiltered = wavPath.replace('.wav', '_bp.wav')

  try {
    // Apply bandpass filter to isolate 1kHz beep
    await new Promise<void>((resolve, reject) => {
      ffmpeg(wavPath)
        .audioFilters(`bandpass=frequency=${BEEP_FREQ}:width_type=h:width=${BANDPASS_HIGH - BANDPASS_LOW}`)
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec('pcm_s16le')
        .output(tempFiltered)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(new Error(`bandpass filter failed: ${err.message}`)))
        .run()
    })

    // Detect silence boundaries in filtered audio — non-silent parts = beep
    const silenceBoundaries = await detectSilenceBoundaries(tempFiltered, {
      silenceThreshold: '-30dB',
      minSilenceDuration: 0.05,
    })

    // The non-silent segments are our beep intervals
    return silenceBoundaries.map((b) => ({
      startSec: Math.round(b.start * 1000) / 1000,
      endSec: Math.round(b.end * 1000) / 1000,
    }))
  } finally {
    await cleanupTemp(tempFiltered)
  }
}

/**
 * Load transcript chunks for a session and extract [MASKED] word intervals.
 */
async function loadMaskedIntervals(sessionId: string): Promise<MaskedInterval[]> {
  const { data, error } = await supabaseAdmin
    .from('transcript_chunks')
    .select('chunk_index, start_sec, words')
    .eq('session_id', sessionId)
    .order('chunk_index', { ascending: true })

  if (error) {
    throw new Error(`Failed to load transcript chunks: ${error.message}`)
  }

  if (!data || data.length === 0) return []

  const intervals: MaskedInterval[] = []

  for (const chunk of data) {
    const words = chunk.words as TranscriptWord[] | null
    if (!words) continue

    const chunkStartSec = Number(chunk.start_sec)

    for (const w of words) {
      if (w.word === '[MASKED]' || w.word.includes('[MASKED]')) {
        intervals.push({
          startSec: Math.round((chunkStartSec + w.start) * 1000) / 1000,
          endSec: Math.round((chunkStartSec + w.end) * 1000) / 1000,
          chunkIndex: chunk.chunk_index,
          word: w.word,
        })
      }
    }
  }

  return mergeOverlapping(intervals)
}

/** Merge overlapping/adjacent masked intervals */
function mergeOverlapping(intervals: MaskedInterval[]): MaskedInterval[] {
  if (intervals.length <= 1) return intervals

  const sorted = [...intervals].sort((a, b) => a.startSec - b.startSec)
  const merged: MaskedInterval[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]
    if (sorted[i].startSec <= prev.endSec + TOLERANCE_SEC) {
      merged[merged.length - 1] = {
        ...prev,
        endSec: Math.max(prev.endSec, sorted[i].endSec),
      }
    } else {
      merged.push(sorted[i])
    }
  }

  return merged
}

/** Check if two intervals overlap within tolerance */
function intervalsOverlap(
  a: { startSec: number; endSec: number },
  b: { startSec: number; endSec: number },
): boolean {
  return a.startSec <= b.endSec + TOLERANCE_SEC && a.endSec >= b.startSec - TOLERANCE_SEC
}

// ── Main Functions ──────────────────────────────────────────────────────

/**
 * Validate sync between transcript [MASKED] tokens and audio beep intervals.
 */
export async function validateMaskSync(sessionId: string): Promise<MaskSyncResult> {
  // 1. Load [MASKED] intervals from transcript
  const maskedIntervals = await loadMaskedIntervals(sessionId)

  if (maskedIntervals.length === 0) {
    return {
      sessionId,
      syncStatus: 'no_masks',
      maskedIntervals: [],
      beepIntervals: [],
      mismatches: [],
      summary: 'No [MASKED] tokens found in transcript',
    }
  }

  // 2. Find the session's user_id for S3 key
  const { data: session, error: sessionError } = await supabaseAdmin
    .from('sessions')
    .select('user_id')
    .eq('id', sessionId)
    .single()

  if (sessionError || !session) {
    return {
      sessionId,
      syncStatus: 'error',
      maskedIntervals,
      beepIntervals: [],
      mismatches: [],
      summary: `Session not found: ${sessionError?.message ?? 'no data'}`,
    }
  }

  // 3. Download audio and detect beep intervals
  const s3Key = `${session.user_id}/${sessionId}.wav`
  const tempPath = await downloadToTemp(s3Key)

  try {
    const beepIntervals = await detectBeepIntervals(tempPath)

    // 4. Cross-check
    const mismatches: MaskMismatch[] = []

    // Check: each masked interval should have a corresponding beep
    for (const masked of maskedIntervals) {
      const hasBeep = beepIntervals.some((beep) => intervalsOverlap(masked, beep))
      if (!hasBeep) {
        mismatches.push({
          type: 'mask_without_beep',
          interval: { startSec: masked.startSec, endSec: masked.endSec },
          detail: `[MASKED] at ${masked.startSec.toFixed(2)}-${masked.endSec.toFixed(2)}s (chunk ${masked.chunkIndex}) has no matching beep`,
        })
      }
    }

    // Check: each beep interval should have a corresponding mask
    for (const beep of beepIntervals) {
      const hasMask = maskedIntervals.some((masked) => intervalsOverlap(masked, beep))
      if (!hasMask) {
        mismatches.push({
          type: 'beep_without_mask',
          interval: { startSec: beep.startSec, endSec: beep.endSec },
          detail: `Beep at ${beep.startSec.toFixed(2)}-${beep.endSec.toFixed(2)}s has no matching [MASKED] token`,
        })
      }
    }

    const syncStatus: SyncStatus = mismatches.length === 0 ? 'synced' : 'mismatch'
    const summary = syncStatus === 'synced'
      ? `${maskedIntervals.length} masked intervals match ${beepIntervals.length} beep intervals`
      : `${mismatches.length} mismatches found: ${maskedIntervals.length} masks, ${beepIntervals.length} beeps`

    return { sessionId, syncStatus, maskedIntervals, beepIntervals, mismatches, summary }
  } finally {
    await cleanupTemp(tempPath)
  }
}

/**
 * Bulk validate mask sync for multiple sessions.
 */
export async function validateBulk(
  sessionIds: string[],
): Promise<MaskSyncResult[]> {
  const results: MaskSyncResult[] = []

  for (const sessionId of sessionIds) {
    try {
      const result = await validateMaskSync(sessionId)
      results.push(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({
        sessionId,
        syncStatus: 'error',
        maskedIntervals: [],
        beepIntervals: [],
        mismatches: [],
        summary: `Validation failed: ${message}`,
      })
    }
  }

  return results
}
