import { describe, it, expect } from 'vitest'
import { extractAudioMetadata } from './audio-metadata.js'

describe('extractAudioMetadata', () => {
  it('returns all-unknown shape when probe is null/undefined', () => {
    const result = extractAudioMetadata(null)
    expect(result.channel_type).toBe('unknown')
    expect(result.sample_rate_hz).toBeNull()
    expect(result.bit_depth).toBeNull()
    expect(result.recording_environment).toBe('unknown')
    expect(result.noise_environment).toBe('unknown')
    expect(result.audio_source_type).toBe('unknown')
    expect(result.estimated_bandwidth).toBe('unknown')
  })

  it('maps mono/stereo channels', () => {
    expect(extractAudioMetadata({ channels: 1 }).channel_type).toBe('mono')
    expect(extractAudioMetadata({ channels: 2 }).channel_type).toBe('stereo')
    expect(extractAudioMetadata({ channels: 6 }).channel_type).toBe('unknown')
  })

  it('preserves sample_rate_hz and bit_depth when numeric', () => {
    const result = extractAudioMetadata({ sample_rate_hz: 16000, bit_depth: 16 })
    expect(result.sample_rate_hz).toBe(16000)
    expect(result.bit_depth).toBe(16)
  })

  it('nulls non-numeric sample_rate_hz/bit_depth', () => {
    const result = extractAudioMetadata({
      sample_rate_hz: null,
      bit_depth: null,
    })
    expect(result.sample_rate_hz).toBeNull()
    expect(result.bit_depth).toBeNull()
  })

  it('maps recording environment from asset_type', () => {
    expect(extractAudioMetadata({ asset_type: 'phone_call' }).recording_environment).toBe('phone_call')
    expect(extractAudioMetadata({ asset_type: 'in_person_meeting' }).recording_environment).toBe('in_person')
    expect(extractAudioMetadata({ asset_type: 'studio_recording' }).recording_environment).toBe('studio')
    expect(extractAudioMetadata({ asset_type: 'voice_memo' }).recording_environment).toBe('mobile')
    expect(extractAudioMetadata({ asset_type: 'something_else' }).recording_environment).toBe('unknown')
  })

  it('maps noise environment by SNR thresholds', () => {
    expect(extractAudioMetadata({ snr_db: 35 }).noise_environment).toBe('quiet')
    expect(extractAudioMetadata({ snr_db: 20 }).noise_environment).toBe('moderate')
    expect(extractAudioMetadata({ snr_db: 5 }).noise_environment).toBe('noisy')
    expect(extractAudioMetadata({ snr_db: null }).noise_environment).toBe('unknown')
  })

  it('maps audio source type', () => {
    expect(extractAudioMetadata({ asset_type: 'phone_call' }).audio_source_type).toBe('phone_line')
    expect(extractAudioMetadata({ asset_type: 'voice_memo' }).audio_source_type).toBe('mic_built_in')
    expect(extractAudioMetadata({ asset_type: 'studio_recording' }).audio_source_type).toBe('mic_external')
  })

  it('maps bandwidth by sample rate', () => {
    expect(extractAudioMetadata({ sample_rate_hz: 44100 }).estimated_bandwidth).toBe('fullband')
    expect(extractAudioMetadata({ sample_rate_hz: 16000 }).estimated_bandwidth).toBe('wideband')
    expect(extractAudioMetadata({ sample_rate_hz: 8000 }).estimated_bandwidth).toBe('narrowband')
    expect(extractAudioMetadata({ sample_rate_hz: 4000 }).estimated_bandwidth).toBe('unknown')
  })

  it('returns only the documented schema fields', () => {
    const result = extractAudioMetadata({ channels: 1, sample_rate_hz: 16000 })
    const keys = Object.keys(result).sort()
    expect(keys).toEqual(
      [
        'audio_source_type',
        'bit_depth',
        'channel_type',
        'estimated_bandwidth',
        'noise_environment',
        'recording_environment',
        'sample_rate_hz',
      ].sort(),
    )
  })
})
