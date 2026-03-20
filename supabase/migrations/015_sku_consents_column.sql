-- ============================================================
-- 015: SKU 카테고리 동의 컬럼 추가 (users_profile)
-- 2026-03-20
-- ============================================================

ALTER TABLE users_profile
  ADD COLUMN IF NOT EXISTS sku_consents JSONB DEFAULT '{}';
