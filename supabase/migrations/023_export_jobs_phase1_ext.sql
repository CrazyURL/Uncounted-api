-- ============================================================
-- Migration 023 — export_jobs phase1 확장 컬럼
-- 패키지 메타데이터 + 다운로드 URL 관리
-- ============================================================

ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS utterance_count      INTEGER;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS package_size_bytes   BIGINT;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS package_storage_path TEXT;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS download_url         TEXT;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS download_expires_at  TIMESTAMPTZ;
