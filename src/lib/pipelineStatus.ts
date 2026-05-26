// ── 처리 파이프라인 "처리 오류" 판정 기준 (단일 소스) ──────────────────
// 대시보드 카운트(admin-dashboard.ts)와 목록 필터(admin-reviews.ts)가 동일한
// 기준을 쓰도록 여기서만 정의한다. 두 곳이 따로 OR 절을 들고 있으면 드리프트가
// 생겨 "배지 N ↔ 클릭 시 행 수 ≠ N" 운영자 혼란을 만든다.
//
// auto_label_status 는 의도적으로 제외한다: 자동 라벨 모델은 재학습 중
// 양성(benign) failed/skipped 가 발생할 수 있어(CLAUDE.md §9/§15) 운영자가
// 조치해야 할 "처리 오류"가 아니다. 근거: scripts/analysis/error_status_audit_20260526.md

/** 처리 오류로 간주하는 GPU 파이프라인 단계 컬럼 (auto_label_status 제외). */
export const PIPELINE_FAILED_STAGES = [
  'gpu_upload_status',
  'stt_status',
  'diarize_status',
  'gpu_pii_status',
  'quality_status',
] as const

/** supabase-js `.or(...)` 용 절: 위 단계 중 하나라도 'failed'. */
export const PIPELINE_FAILED_OR_CLAUSE = PIPELINE_FAILED_STAGES.map(
  (col) => `${col}.eq.failed`,
).join(',')
