-- ============================================================
-- Migration 022 — bu_quality_metrics
-- BU 단위 오디오 품질 분석 결과 저장
-- ============================================================

CREATE TABLE IF NOT EXISTS bu_quality_metrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT NOT NULL,
  bu_index        INTEGER NOT NULL,
  user_id         UUID NOT NULL,
  snr_db          NUMERIC,
  speech_ratio    NUMERIC,
  clipping_ratio  NUMERIC,
  beep_mask_ratio NUMERIC,
  volume_lufs     NUMERIC,
  quality_score   NUMERIC,
  quality_grade   TEXT,
  analyzed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, bu_index)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bqm_session  ON bu_quality_metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_bqm_user     ON bu_quality_metrics(user_id);
CREATE INDEX IF NOT EXISTS idx_bqm_grade    ON bu_quality_metrics(quality_grade);
CREATE INDEX IF NOT EXISTS idx_bqm_analyzed ON bu_quality_metrics(analyzed_at DESC);

-- RLS: service_role만 접근 가능 (일반 유저 접근 차단)
ALTER TABLE bu_quality_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bqm_service_only" ON bu_quality_metrics FOR ALL USING (false) WITH CHECK (false);
