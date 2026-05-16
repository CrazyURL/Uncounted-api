-- Migration 070: auto_label_status + label_at 추가
--
-- auto_label_status: GPU 자동 라벨링 단계 추적 (KcELECTRA)
--   pending  — 미시작
--   running  — 처리 중
--   done     — 완료
--   failed   — 실패
--   skipped  — 모델 없어서 건너뜀 (graceful degradation)
--
-- label_at: 자동 라벨링 완료/건너뜀 시각 (stuck 탐지용)
--
-- 기존 status 컬럼들은 TEXT+CHECK 방식 (enum 미사용, migration 052 참조)

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS auto_label_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS label_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_auto_label_status_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_auto_label_status_check
      CHECK (auto_label_status IN ('pending', 'running', 'done', 'failed', 'skipped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_auto_label_status ON sessions(auto_label_status);

COMMENT ON COLUMN sessions.auto_label_status IS 'GPU 자동 라벨링 단계 상태 (pending/running/done/failed/skipped). skipped=KcELECTRA 모델 없어서 건너뜀.';
COMMENT ON COLUMN sessions.label_at IS '자동 라벨링 완료 또는 건너뜀 시각.';
