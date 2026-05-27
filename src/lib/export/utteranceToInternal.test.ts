import { describe, it, expect } from 'vitest'
import {
  mapUtteranceRowToInternal,
  mapUtteranceRowToSyncInput,
  type UtteranceRowLike,
} from './utteranceToInternal.js'
import { toBaselineUtterance } from './baselineAdapter.js'

const row: UtteranceRowLike = {
  id: 'u1',
  sequence_order: 3,
  speaker_id: 'owner',
  start_sec: '1.0', // supabase NUMERIC 은 string 으로 옴
  end_sec: '2.5',
  duration_sec: '1.5',
  storage_path: 'audio/sess1/u1.wav',
  transcript_text: '안녕하세요 [이름]님',
  label_source: 'whisperx',
  auto_label_model_version: 'kcelectra_emotion_v3',
  dialog_act: '진술',
  pii_intervals: [{ startSec: 1.1, endSec: 1.4, piiType: 'name' }],
}

describe('mapUtteranceRowToInternal', () => {
  it('maps row to InternalUtterance with speaker_label/raw_speaker_role from speaker_id (기존 conflation 미러)', () => {
    const internal = mapUtteranceRowToInternal(row, 'sess1')
    expect(internal.id).toBe('u1')
    expect(internal.session_id).toBe('sess1')
    expect(internal.speaker_label).toBe('owner')
    expect(internal.raw_speaker_role).toBe('owner')
    expect(internal.text_masked).toBe('안녕하세요 [이름]님')
  })

  it('feeds the D6 adapter — owner → owner_candidate, model name not leaked', () => {
    const baseline = toBaselineUtterance(mapUtteranceRowToInternal(row, 'sess1'))
    expect(baseline.speaker_role_candidate).toBe('owner_candidate')
    expect(baseline.label_origin).toBe('automatic') // whisperx
    expect(baseline.label_version).toBe('supervised_model') // kcelectra_*
    expect(JSON.stringify(baseline).toLowerCase()).not.toContain('kcelectra')
    expect(JSON.stringify(baseline).toLowerCase()).not.toContain('whisperx')
  })

  it('null speaker_id → null fields (adapter coerces to unknown / UNKNOWN downstream)', () => {
    const internal = mapUtteranceRowToInternal({ ...row, speaker_id: null }, 'sess1')
    expect(internal.speaker_label).toBeNull()
    expect(internal.raw_speaker_role).toBeNull()
    expect(toBaselineUtterance(internal).speaker_role_candidate).toBe('unknown')
  })
})

describe('mapUtteranceRowToSyncInput', () => {
  it('coerces numeric-string timing and parses pii intervals (snake/camel)', () => {
    const sync = mapUtteranceRowToSyncInput(row)
    expect(sync.utterance_id).toBe('u1')
    expect(sync.start_sec).toBe(1.0)
    expect(sync.end_sec).toBe(2.5)
    expect(sync.duration_sec).toBe(1.5)
    expect(sync.has_transcript).toBe(true)
    expect(sync.has_audio_ref).toBe(true)
    expect(sync.speaker_label).toBe('owner')
    expect(sync.pii_intervals).toEqual([{ start_sec: 1.1, end_sec: 1.4 }])
  })

  it('empty/whitespace transcript → has_transcript false', () => {
    expect(mapUtteranceRowToSyncInput({ ...row, transcript_text: '   ' }).has_transcript).toBe(false)
    expect(mapUtteranceRowToSyncInput({ ...row, transcript_text: null }).has_transcript).toBe(false)
  })

  it('missing storage_path → has_audio_ref false', () => {
    expect(mapUtteranceRowToSyncInput({ ...row, storage_path: null }).has_audio_ref).toBe(false)
  })

  it('null speaker_id → speaker_label UNKNOWN', () => {
    expect(mapUtteranceRowToSyncInput({ ...row, speaker_id: null }).speaker_label).toBe('UNKNOWN')
  })

  it('does NOT carry transcript text into sync input (PII 비노출)', () => {
    const sync = mapUtteranceRowToSyncInput(row)
    expect(JSON.stringify(sync)).not.toContain('[이름]')
    expect(JSON.stringify(sync)).not.toContain('안녕하세요')
  })
})
