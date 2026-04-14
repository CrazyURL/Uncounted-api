-- Migration 035: export_jobs packaging progress tracking + stuck recovery
-- finalize 비동기화 + Cloudflare Tunnel 타임아웃으로 인한 packaging 고착 복구

-- 1) packaging 시작 시각 + 진행 단계 기록 컬럼
ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS packaging_started_at TIMESTAMPTZ;

ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS packaging_stage TEXT;

-- 2) stuck packaging 복구 RPC
--    status='packaging' 이고 packaging_started_at이 p_stale_minutes 이상 경과한 경우에만
--    status를 'reviewing'으로 복원하고 BU lock도 그대로 유지 (재시도 가능).
--    영향받은 row 수를 반환한다 (호출자가 reset 성공 여부 판단).
CREATE OR REPLACE FUNCTION reset_stuck_packaging(
  p_job_id        UUID,
  p_stale_minutes INT DEFAULT 30
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_affected INT;
BEGIN
  UPDATE export_jobs
     SET status               = 'reviewing',
         packaging_started_at = NULL,
         packaging_stage      = NULL
   WHERE id     = p_job_id
     AND status = 'packaging'
     AND (
       packaging_started_at IS NULL
       OR packaging_started_at < NOW() - (p_stale_minutes || ' minutes')::INTERVAL
     );

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected;
END;
$$;
