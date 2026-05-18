import { describe, it, expect } from 'vitest'
import { isExportEligible } from './eligibility.js'

describe('isExportEligible (안전선 #5 광의 적용)', () => {
  // 'locked_or_disputed_future' reason 은 enum 에는 존재하나 현재 로직에서는 emit X
  // (미래 dispute/withdrawal 상태 추가 시 본 함수에서만 emit 하도록 예약).

  it('rejects null / undefined / non-object input', () => {
    expect(isExportEligible(null)).toEqual({
      eligible: false,
      reason: 'consent_not_both_agreed',
    })
    expect(isExportEligible(undefined)).toEqual({
      eligible: false,
      reason: 'consent_not_both_agreed',
    })
    expect(isExportEligible('not-an-object')).toEqual({
      eligible: false,
      reason: 'consent_not_both_agreed',
    })
  })

  it('rejects session where consent_status != both_agreed', () => {
    expect(
      isExportEligible({
        consent_status: 'one_agreed',
        review_status: 'approved',
        session_dataset_eligible: true,
      }),
    ).toEqual({ eligible: false, reason: 'consent_not_both_agreed' })

    expect(
      isExportEligible({
        consent_status: null,
        review_status: 'approved',
      }),
    ).toEqual({ eligible: false, reason: 'consent_not_both_agreed' })
  })

  it('rejects session where review_status != approved', () => {
    expect(
      isExportEligible({
        consent_status: 'both_agreed',
        review_status: 'pending',
        session_dataset_eligible: true,
      }),
    ).toEqual({ eligible: false, reason: 'review_not_approved' })

    expect(
      isExportEligible({
        consent_status: 'both_agreed',
        review_status: 'rejected',
      }),
    ).toEqual({ eligible: false, reason: 'review_not_approved' })
  })

  it('rejects session where session_dataset_eligible === false (explicit)', () => {
    expect(
      isExportEligible({
        consent_status: 'both_agreed',
        review_status: 'approved',
        session_dataset_eligible: false,
      }),
    ).toEqual({ eligible: false, reason: 'dataset_not_eligible' })
  })

  it('passes session where session_dataset_eligible is NULL (not strict false)', () => {
    expect(
      isExportEligible({
        consent_status: 'both_agreed',
        review_status: 'approved',
        session_dataset_eligible: null,
      }),
    ).toEqual({ eligible: true, reason: null })
  })

  it('passes session where session_dataset_eligible is undefined (not strict false)', () => {
    expect(
      isExportEligible({
        consent_status: 'both_agreed',
        review_status: 'approved',
      }),
    ).toEqual({ eligible: true, reason: null })
  })

  it('passes fully approved session with dataset_eligible=true', () => {
    expect(
      isExportEligible({
        consent_status: 'both_agreed',
        review_status: 'approved',
        session_dataset_eligible: true,
      }),
    ).toEqual({ eligible: true, reason: null })
  })

  it('does NOT reference legacy fields (sale_status, dispute_status, export_status)', () => {
    // These columns do not exist in the current schema (CLAUDE.md §14 헷갈리는 사실).
    // Even if present, they should be ignored.
    expect(
      isExportEligible({
        consent_status: 'both_agreed',
        review_status: 'approved',
        sale_status: 'sold',
        dispute_status: 'open',
        export_status: 'failed',
      }),
    ).toEqual({ eligible: true, reason: null })
  })
})
