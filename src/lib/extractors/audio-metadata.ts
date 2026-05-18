/**
 * Audio metadata extractor — 세션 오디오 장비/포맷/녹음 환경 메타.
 *
 * SPEC §4.3.15: sessions.audio_metadata JSONB (기존 audio_metrics 와 별개).
 *   - audio_metrics: 세션 평균 SNR / speech_ratio 등 측정값 (기존)
 *   - audio_metadata: 채널/샘플레이트/비트뎁스/환경/장비/대역폭 (074 신규)
 *
 * 입력은 ffprobe / Voice API stt 산출 메타에서 구성. 누락 시 대응 필드는 unknown / null.
 */

export type ChannelType = 'mono' | 'stereo' | 'unknown'

export type RecordingEnvironment =
  | 'phone_call'
  | 'in_person'
  | 'studio'
  | 'mobile'
  | 'unknown'

export type AudioSourceType =
  | 'phone_line'
  | 'mic_built_in'
  | 'mic_external'
  | 'unknown'

export type NoiseEnvironment = 'quiet' | 'moderate' | 'noisy' | 'unknown'

export type Bandwidth = 'fullband' | 'wideband' | 'narrowband' | 'unknown'

export interface AudioMetadata {
  channel_type: ChannelType
  sample_rate_hz: number | null
  bit_depth: number | null
  recording_environment: RecordingEnvironment
  noise_environment: NoiseEnvironment
  audio_source_type: AudioSourceType
  estimated_bandwidth: Bandwidth
}

export interface AudioMetadataInput {
  /** 채널 수 (1=mono, 2=stereo, 그 외=unknown). */
  channels?: number | null
  /** Hz 단위 샘플레이트 (예: 8000, 16000, 44100). */
  sample_rate_hz?: number | null
  /** 비트 깊이 (예: 8, 16, 24). */
  bit_depth?: number | null
  /** sessions.asset_type 힌트 (phone_call / in_person_meeting / studio_recording / voice_memo 등). */
  asset_type?: string | null
  /** 평균 SNR (dB) — noise_environment 판정. */
  snr_db?: number | null
}

/**
 * Audio metadata 합성. 입력 부족 시 대응 필드 unknown / null.
 */
export function extractAudioMetadata(
  input: AudioMetadataInput | null | undefined,
): AudioMetadata {
  const probe: AudioMetadataInput = input ?? {}

  return {
    channel_type: toChannelType(probe.channels),
    sample_rate_hz: toPositiveInt(probe.sample_rate_hz),
    bit_depth: toPositiveInt(probe.bit_depth),
    recording_environment: toRecordingEnvironment(probe.asset_type),
    noise_environment: toNoiseEnvironment(probe.snr_db),
    audio_source_type: toAudioSourceType(probe.asset_type),
    estimated_bandwidth: toBandwidth(probe.sample_rate_hz),
  }
}

function toPositiveInt(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}

function toChannelType(channels: number | null | undefined): ChannelType {
  if (typeof channels !== 'number' || !Number.isFinite(channels)) return 'unknown'
  if (channels === 1) return 'mono'
  if (channels === 2) return 'stereo'
  return 'unknown'
}

function toRecordingEnvironment(
  asset_type: string | null | undefined,
): RecordingEnvironment {
  if (typeof asset_type !== 'string' || asset_type.length === 0) return 'unknown'
  const v = asset_type.toLowerCase()
  if (v.includes('phone') || v.includes('call')) return 'phone_call'
  if (v.includes('in_person')) return 'in_person'
  if (v.includes('studio')) return 'studio'
  if (v.includes('memo') || v.includes('mobile') || v.includes('voicemail')) return 'mobile'
  return 'unknown'
}

function toAudioSourceType(asset_type: string | null | undefined): AudioSourceType {
  if (typeof asset_type !== 'string' || asset_type.length === 0) return 'unknown'
  const v = asset_type.toLowerCase()
  if (v.includes('phone') || v.includes('call')) return 'phone_line'
  if (v.includes('studio')) return 'mic_external'
  if (v.includes('memo') || v.includes('mobile') || v.includes('in_person')) {
    return 'mic_built_in'
  }
  return 'unknown'
}

function toNoiseEnvironment(snr_db: number | null | undefined): NoiseEnvironment {
  if (typeof snr_db !== 'number' || !Number.isFinite(snr_db)) return 'unknown'
  if (snr_db >= 30) return 'quiet'
  if (snr_db >= 10) return 'moderate'
  return 'noisy'
}

function toBandwidth(sample_rate_hz: number | null | undefined): Bandwidth {
  if (typeof sample_rate_hz !== 'number' || !Number.isFinite(sample_rate_hz)) {
    return 'unknown'
  }
  if (sample_rate_hz >= 44000) return 'fullband'
  if (sample_rate_hz >= 16000) return 'wideband'
  if (sample_rate_hz >= 8000) return 'narrowband'
  return 'unknown'
}
