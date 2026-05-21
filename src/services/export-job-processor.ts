// ── Export Job Processor (창 D — Layer 3 배치 큐 폴링) ────────────────
//
// SPEC_EXPORT_V2.md §6.2 / WORKSTREAM_DEPENDENCIES.md §3.4.
//
// 본 창 (창 D) 산출 = 함수 시그니처 + 차단 사유. 실제 큐 폴링은 다음 두 의존성 완료 후:
//   1. Window A 075+ — export_jobs_v2 테이블 추가
//   2. Window C      — buildBatchExportZip() placeholder 교체
//        (현재 services/export/export-builder.ts:171-173 throw 상태)
//
// 예정 흐름 (의존성 완료 후 별도 워크스트림에서 구현):
//   1. export_jobs_v2 WHERE status='queued' 한 건 선택
//   2. status='processing' + started_at=NOW() UPDATE (낙관적 락)
//   3. buildBatchExportZip(session_ids, options) 호출
//   4. S3 업로드 + signed URL 발급
//   5. status='complete' + storage_path/download_url/expires_at UPDATE
//   6. 실패 시 status='failed' + error_message UPDATE

export interface ExportJobProcessResult {
  processed: number
  failed: number
  reason?: string
}

/**
 * Render Cron Jobs (5분) + HTTP 트리거 양쪽 진입점.
 *
 * 차단 사유: export_jobs_v2 테이블 부재 + buildBatchExportZip placeholder.
 */
export async function runExportJobProcessor(): Promise<ExportJobProcessResult> {
  return {
    processed: 0,
    failed: 0,
    reason:
      'export_jobs_v2 table missing + buildBatchExportZip() placeholder. ' +
      'Both Window A 075+ and Window C completion required.',
  }
}
