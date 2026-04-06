-- 024: 메타데이터 이벤트 테이블
-- 클라이언트 앱에서 수집한 메타데이터(U-M05~U-M18, U-P01)를 서버에 저장.
-- 범용 JSONB 구조: schema_id로 스키마 구분, payload에 원본 레코드 저장.

CREATE TABLE IF NOT EXISTS metadata_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_id   TEXT NOT NULL,
  pseudo_id   TEXT NOT NULL,
  user_id     UUID,
  date_bucket TEXT,
  dedup_key   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_me_dedup ON metadata_events(dedup_key);
CREATE INDEX IF NOT EXISTS idx_me_schema_date  ON metadata_events(schema_id, date_bucket);
CREATE INDEX IF NOT EXISTS idx_me_pseudo       ON metadata_events(pseudo_id);
CREATE INDEX IF NOT EXISTS idx_me_user         ON metadata_events(user_id);

ALTER TABLE metadata_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "me_service_only"
  ON metadata_events
  FOR ALL
  USING (false)
  WITH CHECK (false);
