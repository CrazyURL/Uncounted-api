-- ============================================================
-- 016: sessions 테이블에 consented_at 컬럼 추가
-- 음성 공유 동의 시각 기록 (ISO 8601 타임스탬프)
-- 2026-03-20
-- ============================================================

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN sessions.consented_at IS '음성 공유 동의 시각 (consent ON 시 NOW())';
