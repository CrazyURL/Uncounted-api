-- ============================================================
-- 014: PIPA 동의 컬럼 추가 (users_profile)
-- 2026-03-20
-- ============================================================

ALTER TABLE users_profile
  ADD COLUMN IF NOT EXISTS collect_consent              BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS collect_consent_updated_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS third_party_consent          BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS third_party_consent_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consent_withdrawn            BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS consent_withdrawn_updated_at TIMESTAMPTZ;
