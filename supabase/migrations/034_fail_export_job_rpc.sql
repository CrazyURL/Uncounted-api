-- Migration 034: fail_export_job RPC
-- export job 실패 시 BU unlock + status='failed' 원자적 처리

CREATE OR REPLACE FUNCTION fail_export_job(
  p_job_id   UUID,
  p_error    TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- 1) 이 job이 잠근 BU 전부 해제
  UPDATE billable_units
     SET lock_status      = 'available',
         locked_by_job_id = NULL
   WHERE locked_by_job_id = p_job_id;

  -- 2) job 상태 → failed
  UPDATE export_jobs
     SET status        = 'failed',
         error_message = COALESCE(p_error, error_message)
   WHERE id = p_job_id;
END;
$$;
