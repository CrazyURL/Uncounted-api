/**
 * Utterance-level delivery deliverability helper (발화 단위 납품 포함 판정).
 *
 * 세션 게이트 isExportEligible (안전선 #5) 의 **하위**에서 동작한다.
 * 세션이 export 적격일 때, 각 발화를 납품 패키지에 포함할지 판정한다.
 *
 * 설계: scripts/analysis/design_quality_review_queue_20260523.md §4
 *
 * ⚠️ quality_review_status 는 일반 review_status 와 직교한다 (migration 077 주석 참조).
 *    이 함수는 quality_* 컬럼만 본다 — review_status 는 세션 게이트가 담당.
 *
 * 정책:
 *   - 포함: quality_grade ∈ {A, B} (pending/approved_exception 무관)
 *   - 조건부 포함: quality_grade='C' ∧ quality_review_status='approved_exception'
 *   - 제외/보류:
 *       excluded_low_quality / needs_* / pii_unresolved / D·F / quality missing / C(미승인)
 */

export type DeliverabilityReason =
  | 'excluded_low_quality'
  | 'needs_pii_masking'
  | 'needs_retranscription'
  | 'needs_transcript_edit'
  | 'pii_unresolved'
  | 'grade_below_c'
  | 'c_not_approved'
  | 'quality_missing'

export interface UtteranceDeliverabilityResult {
  included: boolean
  reason: DeliverabilityReason | null
}

interface DeliverabilityInputShape {
  quality_grade?: unknown
  quality_score?: unknown
  quality_review_status?: unknown
  quality_exclusion_reason?: unknown
}

/**
 * 발화 1건의 납품 포함 여부 판정.
 *
 * 검사 순서 (먼저 매칭되는 항목 반환):
 *   1. 명시적 제외/보류 상태 (등급 무관 최우선)
 *   2. quality_exclusion_reason='pii_unresolved'
 *   3. 등급 기반 (A/B 포함, C 조건부, D/F 제외)
 *   4. 등급 미상 → quality_missing
 */
export function isUtteranceDeliverable(utterance: unknown): UtteranceDeliverabilityResult {
  if (!isObject(utterance)) {
    return { included: false, reason: 'quality_missing' }
  }

  const u = utterance as DeliverabilityInputShape
  const status =
    typeof u.quality_review_status === 'string' ? u.quality_review_status : 'pending'
  const exclusionReason =
    typeof u.quality_exclusion_reason === 'string' ? u.quality_exclusion_reason : null
  const grade = normalizeGrade(u.quality_grade)

  // 1. 명시적 제외/보류 상태가 최우선 (A 등급이어도 제외)
  if (status === 'excluded_low_quality') {
    return { included: false, reason: 'excluded_low_quality' }
  }
  if (status === 'needs_pii_masking') {
    return { included: false, reason: 'needs_pii_masking' }
  }
  if (status === 'needs_retranscription') {
    return { included: false, reason: 'needs_retranscription' }
  }
  if (status === 'needs_transcript_edit') {
    return { included: false, reason: 'needs_transcript_edit' }
  }

  // 2. PII 미해결은 사유 컬럼으로도 차단 (status 와 무관)
  if (exclusionReason === 'pii_unresolved') {
    return { included: false, reason: 'pii_unresolved' }
  }

  // 3. 등급 기반
  if (grade === 'A' || grade === 'B') {
    return { included: true, reason: null }
  }
  if (grade === 'C') {
    return status === 'approved_exception'
      ? { included: true, reason: null }
      : { included: false, reason: 'c_not_approved' }
  }
  if (grade === 'D' || grade === 'F') {
    return { included: false, reason: 'grade_below_c' }
  }

  // 4. 등급 미상/미측정 → 재측정 전 납품 보류
  return { included: false, reason: 'quality_missing' }
}

function normalizeGrade(value: unknown): 'A' | 'B' | 'C' | 'D' | 'F' | null {
  if (typeof value !== 'string') return null
  const g = value.trim().toUpperCase()
  if (g === 'A' || g === 'B' || g === 'C' || g === 'D' || g === 'F') return g
  return null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
