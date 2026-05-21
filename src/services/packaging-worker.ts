// ── Packaging Worker (창 D — Layer 1 60min 묶음) ──────────────────────
//
// SPEC_EXPORT_V2.md §6.6 / WORKSTREAM_DEPENDENCIES.md §3.4.
//
// 본 창 (창 D) 산출 = 함수 시그니처 + 입력 검증 + 차단 사유.
// 실제 60min 그리디 묶음 로직은 다음 두 의존성 완료 후 별도 워크스트림에서 채움:
//   1. Window A 075+ 마이그레이션 — delivery_packages 테이블 추가
//   2. Window C — buildDeliveryPackageZip() placeholder 교체
//        (현재 services/export/export-builder.ts:167-169 throw 상태)
//
// 안전선 (실제 로직 구현 시 강제):
//   #5  consent_status='both_agreed' AND review_status='approved'
//   #5  session_dataset_eligible != false (074 게이트)
//   #5  utterances.review_status != 'excluded' 발화만
//   #8  audio_export_mode 기본 'reference_only'
//   #16 60min 묶음 시 세션 분할 절대 금지 (overflow 포함)

export interface PackagingRunResult {
  triggered: boolean
  current_package_id: string | null
  reason?: string
}

/**
 * Render Cron Jobs + HTTP 트리거 양쪽 진입점.
 *
 * 차단 사유: delivery_packages 테이블 부재 + buildDeliveryPackageZip placeholder.
 */
export async function runPackagingWorker(): Promise<PackagingRunResult> {
  return {
    triggered: false,
    current_package_id: null,
    reason:
      'delivery_packages table missing (Window A 075+ pending). ' +
      'Window C buildDeliveryPackageZip() placeholder (Window C pending).',
  }
}
