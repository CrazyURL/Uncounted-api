-- ============================================================
-- Migration 021 — export_package_items
-- SKU 데이터셋 추출 패키지 내 개별 파일 항목
-- ============================================================

CREATE TABLE IF NOT EXISTS export_package_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  export_request_id    UUID NOT NULL,              -- references export_jobs(id)
  session_id           TEXT,
  bu_id                TEXT,
  utterance_id         TEXT,
  user_id              UUID,
  pseudo_id            TEXT,
  file_path_in_package TEXT NOT NULL,
  file_type            TEXT NOT NULL,               -- 'wav' | 'json' | 'jsonl'
  file_size_bytes      BIGINT,
  quality_grade        TEXT,
  qa_score             NUMERIC,
  snr_db               NUMERIC,
  speech_ratio         NUMERIC,
  duration_sec         NUMERIC,
  has_context_labels   BOOLEAN DEFAULT false,
  has_dialog_labels    BOOLEAN DEFAULT false,
  content_hash         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_epi_export_request ON export_package_items(export_request_id);
CREATE INDEX IF NOT EXISTS idx_epi_session        ON export_package_items(session_id);
CREATE INDEX IF NOT EXISTS idx_epi_bu             ON export_package_items(bu_id);
CREATE INDEX IF NOT EXISTS idx_epi_user           ON export_package_items(user_id);
CREATE INDEX IF NOT EXISTS idx_epi_file_type      ON export_package_items(file_type);
CREATE INDEX IF NOT EXISTS idx_epi_quality_grade   ON export_package_items(quality_grade);

-- RLS: service_role만 접근 가능 (일반 유저 접근 차단)
ALTER TABLE export_package_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "epi_service_only" ON export_package_items FOR ALL USING (false) WITH CHECK (false);
