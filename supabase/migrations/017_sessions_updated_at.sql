-- ============================================================
-- sessions 테이블에 updated_at 컬럼 추가
-- 에러: "Could not find the 'updated_at' column of 'sessions' in the schema cache"
-- 원인: 001_mvp_schema.sql에 정의되어 있으나 실제 DB에 컬럼이 존재하지 않음
-- ============================================================

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
