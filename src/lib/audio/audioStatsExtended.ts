import { getAudioStatsFromBuffer } from './ffmpegProcessor.js'

export interface UtteranceAudioMetrics {
  snr_db: number | null
  speech_ratio: number | null
  clipping_ratio: number | null
}

const NULL_METRICS: UtteranceAudioMetrics = {
  snr_db: null,
  speech_ratio: null,
  clipping_ratio: null,
}

/**
 * Best-effort utterance-level audio PROXY METRICS. NEVER THROWS.
 *
 * IMPORTANT — these are proxy approximations, NOT validated acoustic measurements:
 *   - Do NOT use for buyer-facing quality guarantees.
 *   - Do NOT use for session_quality_tier (A/B/C) computation.
 *   - On any failure, all three fields return null (no exception propagation).
 *
 * Proxy definitions:
 *   - snr_db        = peakDb - rmsDb  (dynamic-range proxy, NOT validated acoustic SNR)
 *   - speech_ratio  = 1 - silenceRatio  (clamped 0~1; silenceRatio from -40dB ffmpeg silencedetect)
 *   - clipping_ratio = 1.0 when peakDb >= -0.1 dB else 0.0  (no sample-level scan)
 *
 * Validation status: unverified. A separate acoustic-validation workstream
 * is required before these values are exposed as quality guarantees in
 * delivery packages.
 */
export async function computeUtteranceAudioMetrics(
  wavBuffer: Buffer,
): Promise<UtteranceAudioMetrics> {
  try {
    const stats = await getAudioStatsFromBuffer(wavBuffer)

    const snrDb = Number.isFinite(stats.peakDb) && Number.isFinite(stats.rmsDb)
      ? Math.round((stats.peakDb - stats.rmsDb) * 100) / 100
      : null

    const speechRatio = Number.isFinite(stats.silenceRatio)
      ? Math.round(Math.max(0, Math.min(1, 1 - stats.silenceRatio)) * 1000) / 1000
      : null

    const clippingRatio = Number.isFinite(stats.peakDb)
      ? (stats.peakDb >= -0.1 ? 1.0 : 0.0)
      : null

    return {
      snr_db: snrDb,
      speech_ratio: speechRatio,
      clipping_ratio: clippingRatio,
    }
  } catch {
    return NULL_METRICS
  }
}
