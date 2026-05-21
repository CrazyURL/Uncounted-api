import { describe, it, expect } from 'vitest'
import { evaluateDatasetEligibility } from './datasetEligibility'

// 창 B 평가 helper. 1차 정책(사용자 확정):
// - hard gate: approved, both_agreed, raw_audio_url, utterance_count>=1, quality_tier 비-reject, 미잠금/제외, PII 명시 block 아님
// - 비-gate(warning만): PII 미완료(pii_not_cleared), 짧은 세션(too_short)
// - reference_only.ready = eligible (WAV 불필요), embedded.ready = eligible && wav_present

const ELIGIBLE = {
  review_status: 'approved',
  consent_status: 'both_agreed',
  raw_audio_url: 'raw-audio/u/x.m4a',
  utterance_count: 89,
  total_duration_sec: 120,
  session_quality_tier: null,
  strategy_locked: false,
  lock_reason: null,
  dup_status: 'none',
  dup_representative: null,
  pii_status: 'CLEAR',
  gpu_pii_status: 'done',
  is_pii_cleaned: true,
  wav_present: true,
} as const

describe('evaluateDatasetEligibility — 공통 eligible 판정', () => {
  it('모든 hard gate 통과 → eligible true, reasons 비어있음', () => {
    const r = evaluateDatasetEligibility(ELIGIBLE)
    expect(r.eligible).toBe(true)
    expect(r.reasons).toEqual([])
    expect(r.exportModes.reference_only.ready).toBe(true)
  })

  it('quality_tier null 통과 (미평가는 차단 아님)', () => {
    expect(evaluateDatasetEligibility({ ...ELIGIBLE, session_quality_tier: null }).eligible).toBe(true)
  })

  it('review_status≠approved → review_not_approved', () => {
    const r = evaluateDatasetEligibility({ ...ELIGIBLE, review_status: 'in_review' })
    expect(r.eligible).toBe(false)
    expect(r.reasons).toContain('review_not_approved')
  })

  it('consent≠both_agreed → consent_not_both_agreed', () => {
    const r = evaluateDatasetEligibility({ ...ELIGIBLE, consent_status: 'one_agreed' })
    expect(r.eligible).toBe(false)
    expect(r.reasons).toContain('consent_not_both_agreed')
  })

  it('raw_audio_url 없음 → missing_raw_audio', () => {
    expect(evaluateDatasetEligibility({ ...ELIGIBLE, raw_audio_url: null }).reasons).toContain('missing_raw_audio')
    expect(evaluateDatasetEligibility({ ...ELIGIBLE, raw_audio_url: '   ' }).reasons).toContain('missing_raw_audio')
  })

  it('utterance_count 0 → missing_utterances (MIN_UTT=1)', () => {
    const r = evaluateDatasetEligibility({ ...ELIGIBLE, utterance_count: 0 })
    expect(r.eligible).toBe(false)
    expect(r.reasons).toContain('missing_utterances')
  })

  it('session_quality_tier 명시 reject → quality_rejected (대소문자 무시)', () => {
    expect(evaluateDatasetEligibility({ ...ELIGIBLE, session_quality_tier: 'reject' }).reasons).toContain('quality_rejected')
    expect(evaluateDatasetEligibility({ ...ELIGIBLE, session_quality_tier: 'C_REJECT' }).reasons).toContain('quality_rejected')
  })

  it('strategy_locked=true → locked_or_disputed', () => {
    const r = evaluateDatasetEligibility({ ...ELIGIBLE, strategy_locked: true })
    expect(r.eligible).toBe(false)
    expect(r.reasons).toContain('locked_or_disputed')
  })

  it('lock_reason 존재 → locked_or_disputed', () => {
    expect(evaluateDatasetEligibility({ ...ELIGIBLE, lock_reason: 'strategy' }).reasons).toContain('locked_or_disputed')
  })

  it('중복-비대표(dup_status≠none && dup_representative=false) → excluded', () => {
    const r = evaluateDatasetEligibility({ ...ELIGIBLE, dup_status: 'duplicate', dup_representative: false })
    expect(r.eligible).toBe(false)
    expect(r.reasons).toContain('excluded')
  })

  it('dup_status=none → 제외 아님', () => {
    expect(evaluateDatasetEligibility({ ...ELIGIBLE, dup_status: 'none', dup_representative: null }).eligible).toBe(true)
  })
})

describe('evaluateDatasetEligibility — PII 1차 비-게이트', () => {
  it('PII 명시 block(pii_status=BLOCKED) → eligible false + pii_blocked', () => {
    const r = evaluateDatasetEligibility({ ...ELIGIBLE, pii_status: 'BLOCKED' })
    expect(r.eligible).toBe(false)
    expect(r.reasons).toContain('pii_blocked')
  })

  it('PII 미완료(is_pii_cleaned=false, gpu_pii_status=pending) → eligible 유지 + warning pii_not_cleared', () => {
    const r = evaluateDatasetEligibility({ ...ELIGIBLE, is_pii_cleaned: false, gpu_pii_status: 'pending' })
    expect(r.eligible).toBe(true) // 1차: PII 미완료는 차단 아님
    expect(r.reasons).not.toContain('pii_not_cleared')
    expect(r.warnings).toContain('pii_not_cleared')
  })
})

describe('evaluateDatasetEligibility — 최소 길이 비-게이트', () => {
  it('짧은 세션(total_duration_sec<1)도 eligible 유지 + warning too_short', () => {
    const r = evaluateDatasetEligibility({ ...ELIGIBLE, total_duration_sec: 0.5 })
    expect(r.eligible).toBe(true) // MIN_SEC=0: 길이로 차단 안 함
    expect(r.reasons).not.toContain('too_short')
    expect(r.warnings).toContain('too_short')
  })
})

describe('evaluateDatasetEligibility — mode별 readiness', () => {
  it('eligible + wav_present=true → embedded.ready true', () => {
    const r = evaluateDatasetEligibility({ ...ELIGIBLE, wav_present: true })
    expect(r.exportModes.embedded.ready).toBe(true)
  })

  it('eligible + wav 없음 → reference_only.ready true, embedded.ready false + wav_missing_for_embedded', () => {
    const r = evaluateDatasetEligibility({ ...ELIGIBLE, wav_present: false })
    expect(r.exportModes.reference_only.ready).toBe(true)
    expect(r.exportModes.embedded.ready).toBe(false)
    expect(r.exportModes.embedded.reasons).toContain('wav_missing_for_embedded')
  })

  it('eligible=false면 두 mode 모두 ready=false', () => {
    const r = evaluateDatasetEligibility({ ...ELIGIBLE, review_status: 'pending', wav_present: true })
    expect(r.exportModes.reference_only.ready).toBe(false)
    expect(r.exportModes.embedded.ready).toBe(false)
  })
})

describe('evaluateDatasetEligibility — 복수 사유 누적', () => {
  it('여러 hard gate 동시 위반 → 모든 reason 포함', () => {
    const r = evaluateDatasetEligibility({
      review_status: 'pending',
      consent_status: 'none',
      raw_audio_url: null,
      utterance_count: 0,
    })
    expect(r.eligible).toBe(false)
    expect(r.reasons).toEqual(
      expect.arrayContaining(['review_not_approved', 'consent_not_both_agreed', 'missing_raw_audio', 'missing_utterances']),
    )
  })
})
