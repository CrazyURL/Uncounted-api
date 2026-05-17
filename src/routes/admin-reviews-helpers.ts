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
