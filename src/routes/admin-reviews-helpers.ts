// PII 후보 행에서 distinct session_id 추출 (pii_flag 필터용).
// 후보 0건이면 빈 배열 → 호출부가 빈 결과를 반환(회귀: 0 → 0건).
export function distinctSessionIds(
  rows: ReadonlyArray<{ session_id: string }> | null | undefined,
): string[] {
  return [...new Set((rows ?? []).map((r) => r.session_id))]
}

// 세션별 PII 후보 수 집계 (pii_count 노출용).
export function countCandidatesBySession(
  rows: ReadonlyArray<{ session_id: string }> | null | undefined,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const r of rows ?? []) {
    counts.set(r.session_id, (counts.get(r.session_id) ?? 0) + 1)
  }
  return counts
}

// 파이프라인 단계 컬럼 단일 출처(single source of truth).
// pipelineComplete 가 검사하는 컬럼과 전환 핸들러의 SELECT 컬럼이 어긋나면
// (예: SELECT 에서 auto_label_status 누락) pipelineComplete 가 항상 false 가 되어
// 모든 pending→in_review 전환이 409 로 막힌다. 두 곳을 이 상수에서 파생시켜 드리프트를 차단.
export const PIPELINE_STATUS_COLUMNS = [
  'gpu_upload_status',
  'stt_status',
  'diarize_status',
  'gpu_pii_status',
  'auto_label_status',
  'quality_status',
] as const

// 처리 흐름이 모두 done/skipped 인지 — pending → in_review 전환 가능 여부 체크용.
// PIPELINE_STATUS_COLUMNS 의 모든 컬럼이 terminal 이어야 true.
export function pipelineComplete(row: Record<string, unknown>): boolean {
  const terminal = (v: unknown) => v === 'done' || v === 'skipped'
  return PIPELINE_STATUS_COLUMNS.every((col) => terminal(row[col]))
}

// review_status 전환 핸들러용 SELECT 컬럼 목록.
// pipelineComplete 가 읽는 모든 단계 컬럼을 반드시 포함한다(드리프트 방지).
export const REVIEW_TRANSITION_SELECT = [
  'id',
  'review_status',
  ...PIPELINE_STATUS_COLUMNS,
].join(', ')

// running 필터 OR 절 — stuck(이전 단계 완료 후 30분 초과) 세션 제외
// threshold: ISO 8601 (Date.now() - 30min)
export function buildRunningOrClause(threshold: string): string {
  return (
    `gpu_upload_status.eq.running,` +
    `and(stt_status.eq.running,or(gpu_uploaded_at.is.null,gpu_uploaded_at.gte.${threshold})),` +
    `and(diarize_status.eq.running,or(stt_at.is.null,stt_at.gte.${threshold})),` +
    `and(gpu_pii_status.eq.running,or(diarize_at.is.null,diarize_at.gte.${threshold})),` +
    `and(auto_label_status.eq.running,or(gpu_pii_at.is.null,gpu_pii_at.gte.${threshold})),` +
    `and(quality_status.eq.running,or(label_at.is.null,label_at.gte.${threshold}))`
  )
}
