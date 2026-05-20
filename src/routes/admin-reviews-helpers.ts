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
