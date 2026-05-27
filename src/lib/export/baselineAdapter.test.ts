import { describe, it, expect } from 'vitest'
import {
  toBaselineUtterance,
  wrapExtension,
  assertNoBaselinePollution,
  runSyncIntegrityGate,
  DEFAULT_BASELINE_PACKAGE_METADATA,
  type BaselineUtteranceRecord,
  type InternalUtterance,
} from './baselineAdapter.js'

const baseUtt: InternalUtterance = {
  id: 'utt-1',
  session_id: 'sess-1',
  sequence_order: 0,
  speaker_label: 'SPEAKER_00',
  raw_speaker_role: 'owner',
  start_sec: 1.5,
  end_sec: 3.25,
  text_masked: '안녕하세요 [이름]님',
  label_source: 'whisperx',
  auto_label_model_version: 'kcelectra_emotion_v3',
  dialog_act: '진술',
}

describe('toBaselineUtterance — 정규화 위치 단일화 (transforms 재사용)', () => {
  it('maps anchor-user role via sanitizeExternalSpeakerRole (owner → owner_candidate)', () => {
    expect(toBaselineUtterance(baseUtt).speaker_role_candidate).toBe('owner_candidate')
    expect(toBaselineUtterance({ ...baseUtt, raw_speaker_role: 'counterparty' }).speaker_role_candidate)
      .toBe('counterparty_candidate')
  })

  it('coerces non-anchor/raw confirmed roles (self/other/null) to unknown (안전선 #1)', () => {
    expect(toBaselineUtterance({ ...baseUtt, raw_speaker_role: 'self' }).speaker_role_candidate).toBe('unknown')
    expect(toBaselineUtterance({ ...baseUtt, raw_speaker_role: 'other' }).speaker_role_candidate).toBe('unknown')
    expect(toBaselineUtterance({ ...baseUtt, raw_speaker_role: null }).speaker_role_candidate).toBe('unknown')
  })

  it('never leaks internal model names — label_origin/version via 5-allowlist (안전선 #6)', () => {
    const rec = toBaselineUtterance(baseUtt)
    expect(rec.label_origin).toBe('automatic') // whisperx → automatic
    expect(rec.label_version).toBe('supervised_model') // kcelectra_* → supervised_model
    // raw model name 문자열이 baseline 표준 키 어디에도 남지 않음
    const serialized = JSON.stringify({
      ...rec,
      uncounted_extensions: undefined,
    })
    expect(serialized.toLowerCase()).not.toContain('kcelectra')
    expect(serialized.toLowerCase()).not.toContain('whisperx')
  })

  it('maps dialog_act to SPEC standard group (진술 → 정보), unmatched → null', () => {
    expect(toBaselineUtterance(baseUtt).dialog_act_group).toBe('정보')
    expect(toBaselineUtterance({ ...baseUtt, dialog_act: '존재하지않는행위' }).dialog_act_group).toBeNull()
  })

  it('coerces numeric-string timing to numbers; keeps masked text as-is', () => {
    const rec = toBaselineUtterance({ ...baseUtt, start_sec: '2.0', end_sec: '4.0' })
    expect(rec.start_sec).toBe(2.0)
    expect(rec.end_sec).toBe(4.0)
    expect(rec.text).toBe('안녕하세요 [이름]님')
  })

  it('falls back speaker_label to UNKNOWN when missing', () => {
    expect(toBaselineUtterance({ ...baseUtt, speaker_label: null }).speaker_label).toBe('UNKNOWN')
  })
})

describe('namespace separation — baseline 표준 vs uncounted_extensions 격리', () => {
  it('does NOT emit session-level constants per-utterance (label-schema additionalProperties:false 호환)', () => {
    const rec = toBaselineUtterance(baseUtt)
    expect(rec).not.toHaveProperty('audio_type')
    expect(rec).not.toHaveProperty('locale')
    expect(rec).not.toHaveProperty('dataset_provider')
    // 세션 상수는 별도 metadata 구조에만 존재
    expect(DEFAULT_BASELINE_PACKAGE_METADATA.audio_type).toBe('Mono')
    expect(DEFAULT_BASELINE_PACKAGE_METADATA.locale).toBe('ko-KR')
    expect(DEFAULT_BASELINE_PACKAGE_METADATA.dataset_provider).toBe('Uncounted')
  })

  it('places proprietary values only under uncounted_extensions, wrapped in envelope', () => {
    const rec = toBaselineUtterance(baseUtt, {
      speaker_consistency_score: wrapExtension(0.82, {
        method: 'heuristic_mvp',
        version: 'heuristic_mvp',
        confidence: 0.82,
      }),
    })
    expect(rec.uncounted_extensions.speaker_consistency_score).toEqual({
      value: 0.82,
      method: 'heuristic_mvp',
      version: 'heuristic_mvp',
      confidence: 0.82,
    })
    // baseline top-level 에는 해당 키 없음
    expect(rec).not.toHaveProperty('speaker_consistency_score')
  })

  it('empty extensions by default (골격: 어댑터는 extension 값을 계산하지 않음)', () => {
    expect(toBaselineUtterance(baseUtt).uncounted_extensions).toEqual({})
  })
})

describe('wrapExtension — envelope 정규화', () => {
  it('normalizes method/version via 5-allowlist; null confidence on non-finite', () => {
    const ext = wrapExtension('value', { method: 'aihub_x', version: 'pyannote_v2', confidence: NaN })
    expect(ext.method).toBe('supervised_model') // aihub_* → supervised_model
    expect(ext.version).toBe('automatic') // pyannote → automatic
    expect(ext.confidence).toBeNull()
  })

  it('defaults method/version to not_available when absent', () => {
    const ext = wrapExtension(42)
    expect(ext.method).toBe('not_available')
    expect(ext.version).toBe('not_available')
    expect(ext.confidence).toBeNull()
  })
})

describe('assertNoBaselinePollution — baseline 오염 차단 (fail-closed)', () => {
  it('passes for a clean baseline record', () => {
    expect(() => assertNoBaselinePollution(toBaselineUtterance(baseUtt))).not.toThrow()
  })

  it('throws when a Phase 3-4 intelligence key is injected into baseline namespace', () => {
    const polluted = {
      ...toBaselineUtterance(baseUtt),
      negotiation_pressure_score: 0.9,
    } as unknown as BaselineUtteranceRecord
    expect(() => assertNoBaselinePollution(polluted)).toThrow(/proprietary key/)
  })

  it('does NOT flag proprietary values that live under uncounted_extensions', () => {
    const rec = toBaselineUtterance(baseUtt, {
      negotiation_pressure_score: wrapExtension(0.9),
    })
    // 키가 uncounted_extensions 안에 있으면 baseline 표준 키 검사 대상 아님
    expect(() => assertNoBaselinePollution(rec)).not.toThrow()
  })
})

describe('runSyncIntegrityGate — 훅 자리(STUB) 타입 계약', () => {
  it('returns all 8 referential checks, currently not_implemented + ok:true (미배선)', () => {
    const result = runSyncIntegrityGate()
    expect(result.ok).toBe(true)
    expect(result.checks).toHaveLength(8)
    const names = result.checks.map((c) => c.name).sort()
    expect(names).toEqual(
      [
        'duration_match',
        'mask_in_bounds',
        'metadata_audio_pairing',
        'pii_in_bounds',
        'speaker_id_in_profile',
        'timeline_post_clip_match',
        'transcript_audio_align',
        'utterance_id_file_match',
      ].sort(),
    )
    expect(result.checks.every((c) => c.detail === 'not_implemented (D1)')).toBe(true)
  })
})
