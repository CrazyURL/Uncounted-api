import { describe, it, expect } from 'vitest'
import { isUtteranceDeliverable } from './utteranceDeliverability.js'

// 설계: scripts/analysis/design_quality_review_queue_20260523.md §4
// 세션 게이트(isExportEligible) 하위에서 동작하는 발화 단위 납품 포함 판정.

describe('isUtteranceDeliverable (발화 단위 납품 포함 정책)', () => {
  describe('포함: A/B 등급', () => {
    it('A 등급 + pending → 포함 (검수 불필요)', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'A', quality_review_status: 'pending' }),
      ).toEqual({ included: true, reason: null })
    })

    it('B 등급 + pending → 포함', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'B', quality_review_status: 'pending' }),
      ).toEqual({ included: true, reason: null })
    })

    it('A 등급 + approved_exception → 포함', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'A', quality_review_status: 'approved_exception' }),
      ).toEqual({ included: true, reason: null })
    })

    it('소문자 등급도 정규화하여 포함', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'b', quality_review_status: 'pending' }),
      ).toEqual({ included: true, reason: null })
    })
  })

  describe('조건부 포함: C 등급', () => {
    it('C + approved_exception → 포함', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'C', quality_review_status: 'approved_exception' }),
      ).toEqual({ included: true, reason: null })
    })

    it('C + pending → 제외 (c_not_approved, 보류)', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'C', quality_review_status: 'pending' }),
      ).toEqual({ included: false, reason: 'c_not_approved' })
    })

    it('C + status 미지정 → 제외 (기본 pending 취급)', () => {
      expect(isUtteranceDeliverable({ quality_grade: 'C' })).toEqual({
        included: false,
        reason: 'c_not_approved',
      })
    })
  })

  describe('명시적 제외/보류 상태 (등급 무관 최우선)', () => {
    it('excluded_low_quality → 제외 (A 등급이어도)', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'A', quality_review_status: 'excluded_low_quality' }),
      ).toEqual({ included: false, reason: 'excluded_low_quality' })
    })

    it('needs_pii_masking → 보류(제외)', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'B', quality_review_status: 'needs_pii_masking' }),
      ).toEqual({ included: false, reason: 'needs_pii_masking' })
    })

    it('needs_retranscription → 보류(제외)', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'C', quality_review_status: 'needs_retranscription' }),
      ).toEqual({ included: false, reason: 'needs_retranscription' })
    })

    it('needs_transcript_edit → 보류(제외)', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'A', quality_review_status: 'needs_transcript_edit' }),
      ).toEqual({ included: false, reason: 'needs_transcript_edit' })
    })

    it('quality_exclusion_reason=pii_unresolved → 제외 (status 와 무관)', () => {
      expect(
        isUtteranceDeliverable({
          quality_grade: 'A',
          quality_review_status: 'pending',
          quality_exclusion_reason: 'pii_unresolved',
        }),
      ).toEqual({ included: false, reason: 'pii_unresolved' })
    })
  })

  describe('등급 하위/미상', () => {
    it('D 등급 → 제외 (grade_below_c)', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'D', quality_review_status: 'pending' }),
      ).toEqual({ included: false, reason: 'grade_below_c' })
    })

    it('F 등급 → 제외 (grade_below_c)', () => {
      expect(isUtteranceDeliverable({ quality_grade: 'F' })).toEqual({
        included: false,
        reason: 'grade_below_c',
      })
    })

    it('grade=null & score=null → 보류 (quality_missing)', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: null, quality_score: null }),
      ).toEqual({ included: false, reason: 'quality_missing' })
    })

    it('grade=null & score 있어도 → 보류 (등급 미측정, 안전하게 제외)', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: null, quality_score: 72 }),
      ).toEqual({ included: false, reason: 'quality_missing' })
    })

    it('grade 미지정(undefined) → 보류 (quality_missing)', () => {
      expect(isUtteranceDeliverable({})).toEqual({
        included: false,
        reason: 'quality_missing',
      })
    })
  })

  describe('robustness', () => {
    it('null / 비객체 입력 → 안전하게 제외', () => {
      expect(isUtteranceDeliverable(null)).toEqual({ included: false, reason: 'quality_missing' })
      expect(isUtteranceDeliverable(undefined)).toEqual({ included: false, reason: 'quality_missing' })
      expect(isUtteranceDeliverable('x')).toEqual({ included: false, reason: 'quality_missing' })
    })

    it('알 수 없는 등급 값 → 보류 (quality_missing)', () => {
      expect(isUtteranceDeliverable({ quality_grade: 'Z' })).toEqual({
        included: false,
        reason: 'quality_missing',
      })
    })

    it('명시 제외가 등급 하위보다 우선 (D + excluded_low_quality → excluded_low_quality)', () => {
      expect(
        isUtteranceDeliverable({ quality_grade: 'D', quality_review_status: 'excluded_low_quality' }),
      ).toEqual({ included: false, reason: 'excluded_low_quality' })
    })
  })
})
