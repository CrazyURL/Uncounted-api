-- ============================================================
-- Migration 023 — export_jobs phase1 확장 컬럼
-- 패키지 메타데이터 + 다운로드 URL 관리
-- ============================================================

ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS client_name TEXT;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS quantity_unit TEXT DEFAULT 'hours';
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS consent_level TEXT DEFAULT 'both_agreed';
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS quality_summary JSONB;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS package_storage_path TEXT;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS download_url TEXT;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
