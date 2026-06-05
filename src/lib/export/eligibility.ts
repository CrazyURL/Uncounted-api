/**
 * Export eligibility helper.
 *
 * 안전선 #5 (광의): export 부적격 상태 세션/발화 export 금지.
 *   - consent_status !== 'both_agreed' 또는
 *   - review_status !== 'approved' 또는
 *   - session_dataset_eligible === false (074 신규 게이트)
 *   → 외부 ZIP 노출 X.
 *
 * 향후 신규 부적격 상태 (dispute/withdrawal 등) 발생 시 본 함수만 수정.
 * 별도 안전선 신설 X — #5 광의 정의에 통합 (CLAUDE.md §14).
 *
 * 참조 금지 (현 스키마 미존재):
 *   - sale_status, getSaleStatus, dispute_status, export_status
 */

export type ExportEligibilityReason =
  | 'consent_not_both_agreed'
  | 'review_not_approved'
  | 'dataset_not_eligible'
  | 'locked_or_disputed_future'
  | 'user_learning_opt_out'

export interface ExportEligibilityResult {
  eligible: boolean
  reason: ExportEligibilityReason | null
}

interface EligibilitySessionShape {
  consent_status?: unknown
  review_status?: unknown
  session_dataset_eligible?: unknown
}

interface EligibilityUserShape {
  learning_opt_out?: unknown
}

/**
 * 세션 export 적격성 판정.
 *
 * 검사 순서 (실패 시 즉시 reason 반환):
 *   0. user.learning_opt_out !== true  (PIPC 2026 v1.3 §13.1 — 학습 거부 사용자 우선 차단)
 *   1. consent_status === 'both_agreed'
 *   2. review_status === 'approved'
 *   3. session_dataset_eligible !== false  (NULL/undefined 는 미평가로 간주 → 통과)
 *
 * user 인자는 선택. 미전달 시 #0 검사 건너뜀 (caller 가 user join 안 한 경우).
 * 단, 074 직후 DEFAULT false 상태에서는 #3 가 차단 단계로 작동.
 * 창 B 가 평가 후 true/false 세팅.
 */
export function isExportEligible(
  session: unknown,
  user?: unknown,
): ExportEligibilityResult {
  if (!isObject(session)) {
    return { eligible: false, reason: 'consent_not_both_agreed' }
  }

  // PIPC v1.3 §13.1 — 학습 거부 사용자 데이터는 export 전면 차단
  if (isObject(user)) {
    const u = user as EligibilityUserShape
    if (u.learning_opt_out === true) {
      return { eligible: false, reason: 'user_learning_opt_out' }
    }
  }

  const s = session as EligibilitySessionShape

  if (s.consent_status !== 'both_agreed') {
    return { eligible: false, reason: 'consent_not_both_agreed' }
  }

  if (s.review_status !== 'approved') {
    return { eligible: false, reason: 'review_not_approved' }
  }

  if (s.session_dataset_eligible === false) {
    return { eligible: false, reason: 'dataset_not_eligible' }
  }

  return { eligible: true, reason: null }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
