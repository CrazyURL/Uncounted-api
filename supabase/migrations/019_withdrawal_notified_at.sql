-- ============================================================
-- 019: PIPA 동의 철회 납품처 통지 날짜 컬럼 추가 (users_profile)
-- 2026-03-27
-- ============================================================

ALTER TABLE users_profile
  ADD COLUMN IF NOT EXISTS withdrawal_notified_at TIMESTAMPTZ;
