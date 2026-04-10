-- ============================================================
-- Migration 031 — export_jobs type 컬럼 추가
-- 오디오/메타데이터 export 구분용
-- ============================================================

ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'audio';
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS download_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ej_type ON export_jobs(type);
