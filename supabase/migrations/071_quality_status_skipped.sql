-- Migration 071: quality_status CHECK에 'skipped' 추가
--
-- 배경: gpu-worker가 품질 계산 실패 시 quality_status='skipped'로 설정하도록
-- Phase 3 변경 예정. 기존 CHECK(... IN ('pending','running','done','failed'))에
-- 'skipped' 추가.
--
-- TEXT+CHECK 방식 (enum 미사용, migration 052 참조)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_quality_status_check') THEN
    ALTER TABLE sessions DROP CONSTRAINT sessions_quality_status_check;
  END IF;

  ALTER TABLE sessions ADD CONSTRAINT sessions_quality_status_check
    CHECK (quality_status IN ('pending', 'running', 'done', 'failed', 'skipped'));
END $$;

COMMENT ON COLUMN sessions.quality_status IS '품질 계산 단계 상태 (pending/running/done/failed/skipped). skipped=품질 계산 실패 시 graceful degradation.';
