-- Migration 037: review sync status tracking
-- PUT /utterances/review 비동기 처리의 진행 상태 추적.
-- 클라이언트가 폴링으로 review 완료를 확인한 뒤 finalize를 호출하도록 한다.

-- 1) review sync 추적 컬럼
ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS review_sync_status TEXT DEFAULT 'idle';
  -- 'idle' | 'syncing' | 'done' | 'failed'

ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS review_sync_started_at TIMESTAMPTZ;

ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS review_sync_error TEXT;

-- 2) stuck review sync 복구 RPC
--    review_sync_status='syncing' 이고 review_sync_started_at이 p_stale_minutes 이상 경과한 경우
--    review_sync_status를 'idle'로 복원하여 재시도 가능하게 한다.
CREATE OR REPLACE FUNCTION reset_stuck_review_sync(
  p_job_id        UUID,
  p_stale_minutes INT DEFAULT 5
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_affected INT;
BEGIN
  UPDATE export_jobs
     SET review_sync_status     = 'idle',
         review_sync_started_at = NULL,
         review_sync_error      = NULL
   WHERE id                   = p_job_id
     AND review_sync_status   = 'syncing'
     AND (
       review_sync_started_at IS NULL
       OR review_sync_started_at < NOW() - (p_stale_minutes || ' minutes')::INTERVAL
     );

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected;
END;
$$;
