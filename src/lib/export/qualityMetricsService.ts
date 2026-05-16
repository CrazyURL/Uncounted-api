// ── Quality Metrics Analysis Service ────────────────────────────────────
// S3에서 WAV 다운로드 → FFmpeg로 품질 분석 → bu_quality_metrics에 저장

import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, unlink, mkdir } from 'fs/promises'
import { s3Client, S3_AUDIO_BUCKET } from '../s3.js'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getAudioStats } from '../audio/ffmpegProcessor.js'
import {
  upsertQualityMetricsBatch,
  type BuQualityMetricsInsert,
  type BuQualityMetricsRow,
} from './qualityMetricsRepository.js'
import { supabaseAdmin } from '../supabase.js'

export interface SessionQualityResult {
  sessionId: string
  userId: string
  metrics: BuQualityMetricsRow[]
}

/**
 * Compute a quality grade from raw metrics.
 * A: score >= 80, B: score >= 50, C: below 50
 */
export function computeQualityGrade(score: number): string {
  if (score >= 80) return 'A'
  if (score >= 50) return 'B'
  return 'C'
}

/**
 * Compute a quality score (0-100) from audio stats.
 * Factors: SNR contribution (higher is better), silence ratio penalty, clipping penalty.
 */
export function computeQualityScore(stats: {
  rmsDb: number
  peakDb: number
  silenceRatio: number
  durationSec: number
}): { qualityScore: number; snrDb: number; speechRatio: number; clippingRatio: number } {
  // SNR estimate: peak - RMS (higher = cleaner)
  const snrDb = Math.abs(stats.peakDb - stats.rmsDb)
  const speechRatio = Math.max(0, 1 - stats.silenceRatio)

  // Clipping: if peak is near 0 dBFS, likely clipping
  const clippingRatio = stats.peakDb > -1 ? Math.min(1, (stats.peakDb + 1) / 1) : 0

  // Score components (0-100 each)
  const snrScore = Math.min(100, Math.max(0, snrDb * 3))          // 33dB SNR → 100
  const speechScore = Math.min(100, speechRatio * 120)              // 83%+ speech → 100
  const clippingPenalty = clippingRatio * 30                        // up to -30 points

  const qualityScore = Math.round(
    Math.max(0, Math.min(100, snrScore * 0.4 + speechScore * 0.4 + 20 - clippingPenalty)),
  )

  return { qualityScore, snrDb, speechRatio, clippingRatio }
}

/** Download a WAV file from S3 to a temp path */
async function downloadWavToTemp(s3Key: string): Promise<string> {
  const tempDir = join(tmpdir(), 'uncounted-quality')
  await mkdir(tempDir, { recursive: true })

  const tempPath = join(tempDir, `${Date.now()}_${Math.random().toString(36).slice(2)}.wav`)

  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: S3_AUDIO_BUCKET, Key: s3Key }),
  )

  if (!response.Body) {
    throw new Error(`Empty response body for S3 key: ${s3Key}`)
  }

  const bytes = await response.Body.transformToByteArray()
  await writeFile(tempPath, bytes)

  return tempPath
}

/** Clean up temp file, ignoring errors */
async function cleanupTemp(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // ignore cleanup errors
  }
}

/**
 * Analyze quality for a single session's audio.
 * Downloads WAV from S3, runs FFmpeg analysis, saves metrics per BU (1-minute segment).
 */
/**
 * Aggregate client-measured quality metrics from utterances table.
 * Returns metrics per BU (1-minute segment) using utterance averages.
 */
async function aggregateClientMetrics(
  sessionId: string,
  userId: string,
): Promise<SessionQualityResult | null> {
  const { data: utterances, error } = await supabaseAdmin
    .from('utterances')
    .select('snr_db, speech_ratio, clipping_ratio, beep_mask_ratio, volume_lufs, quality_score, quality_grade, duration_sec')
    .eq('session_id', sessionId)
    .eq('upload_status', 'uploaded')
    .not('quality_score', 'is', null)

  if (error || !utterances || utterances.length === 0) {
    return null
  }

  // Compute session-level averages
  const totalDuration = utterances.reduce((sum, u) => sum + Number(u.duration_sec || 0), 0)
  const avgSnrDb = utterances.reduce((sum, u) => sum + Number(u.snr_db || 0), 0) / utterances.length
  const avgSpeechRatio = utterances.reduce((sum, u) => sum + Number(u.speech_ratio || 0), 0) / utterances.length
  const avgClippingRatio = utterances.reduce((sum, u) => sum + Number(u.clipping_ratio || 0), 0) / utterances.length
  const avgVolumeLufs = utterances.reduce((sum, u) => sum + Number(u.volume_lufs || 0), 0) / utterances.length
  const avgQualityScore = utterances.reduce((sum, u) => sum + Number(u.quality_score || 0), 0) / utterances.length

  const buCount = Math.max(1, Math.ceil(totalDuration / 60))
  const inserts: BuQualityMetricsInsert[] = []

  for (let i = 0; i < buCount; i++) {
    const score = Math.round(avgQualityScore)
    inserts.push({
      session_id: sessionId,
      bu_index: i,
      user_id: userId,
      snr_db: Math.round(avgSnrDb * 100) / 100,
      speech_ratio: Math.round(avgSpeechRatio * 10000) / 10000,
      clipping_ratio: Math.round(avgClippingRatio * 10000) / 10000,
      volume_lufs: Math.round(avgVolumeLufs * 100) / 100,
      quality_score: score,
      quality_grade: computeQualityGrade(score),
    })
  }

  const metrics = await upsertQualityMetricsBatch(inserts)

  for (const m of metrics) {
    await supabaseAdmin
      .from('billable_units')
      .update({
        quality_grade: m.quality_grade,
        qa_score: m.quality_score,
      })
      .eq('session_id', sessionId)
      .eq('minute_index', m.bu_index)
  }

  return { sessionId, userId, metrics }
}

export async function analyzeSessionQuality(
  sessionId: string,
  userId: string,
): Promise<SessionQualityResult> {
  // v3: 클라이언트 측정값이 있으면 FFmpeg 분석 스킵
  const clientResult = await aggregateClientMetrics(sessionId, userId)
  if (clientResult) {
    return clientResult
  }

  // 레거시 폴백: FFmpeg 분석
  const s3Key = `${userId}/${sessionId}/${sessionId}.wav`
  const tempPath = await downloadWavToTemp(s3Key)

  try {
    const stats = await getAudioStats(tempPath)
    const duration = stats.durationSec

    // Each BU = 1 minute segment
    const buCount = Math.ceil(duration / 60)
    const inserts: BuQualityMetricsInsert[] = []

    for (let i = 0; i < buCount; i++) {
      const segmentDuration = Math.min(60, duration - i * 60)
      const { qualityScore, snrDb, speechRatio, clippingRatio } = computeQualityScore({
        ...stats,
        durationSec: segmentDuration,
      })

      inserts.push({
        session_id: sessionId,
        bu_index: i,
        user_id: userId,
        snr_db: Math.round(snrDb * 100) / 100,
        speech_ratio: Math.round(speechRatio * 10000) / 10000,
        clipping_ratio: Math.round(clippingRatio * 10000) / 10000,
        volume_lufs: Math.round(stats.rmsDb * 100) / 100,
        quality_score: qualityScore,
        quality_grade: computeQualityGrade(qualityScore),
      })
    }

    const metrics = await upsertQualityMetricsBatch(inserts)

    // Update billable_units quality fields
    for (const m of metrics) {
      await supabaseAdmin
        .from('billable_units')
        .update({
          quality_grade: m.quality_grade,
          qa_score: m.quality_score,
        })
        .eq('session_id', sessionId)
        .eq('minute_index', m.bu_index)
    }

    return { sessionId, userId, metrics }
  } finally {
    await cleanupTemp(tempPath)
  }
}

/**
 * Bulk analyze quality for multiple sessions.
 * Processes sequentially to avoid overwhelming FFmpeg/S3.
 */
export async function analyzeBulk(
  sessions: Array<{ sessionId: string; userId: string }>,
): Promise<SessionQualityResult[]> {
  const results: SessionQualityResult[] = []

  for (const { sessionId, userId } of sessions) {
    try {
      const result = await analyzeSessionQuality(sessionId, userId)
      results.push(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Quality analysis failed for session ${sessionId}: ${message}`)
    }
  }

  return results
}
