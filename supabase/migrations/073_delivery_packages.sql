-- Migration 073: delivery_packages + export_jobs + export_logs 테이블
-- 3-Layer Export 인프라 — 납품 패키지 / 비동기 익스포트 작업 / 다운로드 감사 로그

CREATE TABLE IF NOT EXISTS delivery_packages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_number        TEXT NOT NULL UNIQUE,
  filename              TEXT NOT NULL,
  storage_path          TEXT NOT NULL,
  status                TEXT NOT NULL
    CHECK (status IN ('building', 'complete', 'pending', 'archived')),
  duration_seconds      NUMERIC NOT NULL,
  duration_minutes      NUMERIC NOT NULL,
  billable_hours        INTEGER NOT NULL,
  session_count         INTEGER NOT NULL,
  utterance_count       INTEGER NOT NULL,
  size_bytes            BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  delivered_to_client_id UUID,
  metadata              JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_delivery_packages_status
  ON delivery_packages(status);

-- sessions에 패키지 참조 연결
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS in_package_id  UUID REFERENCES delivery_packages(id),
  ADD COLUMN IF NOT EXISTS packaged_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sessions_in_package_id
  ON sessions(in_package_id)
  WHERE in_package_id IS NOT NULL;

-- 비동기 익스포트 작업 큐
CREATE TABLE IF NOT EXISTS export_jobs_v2 (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL
    CHECK (type IN ('single_session', 'batch_session', 'delivery_package')),
  status          TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'complete', 'failed')),
  session_ids     JSONB,
  package_id      UUID REFERENCES delivery_packages(id),
  storage_path    TEXT,
  user_id         UUID,
  progress        INTEGER DEFAULT 0,
  total           INTEGER,
  error_message   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_export_jobs_v2_status
  ON export_jobs_v2(status);
CREATE INDEX IF NOT EXISTS idx_export_jobs_v2_user_id
  ON export_jobs_v2(user_id);

-- 익스포트 다운로드 감사 로그
CREATE TABLE IF NOT EXISTS export_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL
    CHECK (type IN ('layer1_package', 'layer2_single', 'layer3_batch')),
  user_id         UUID,
  package_id      UUID REFERENCES delivery_packages(id),
  session_ids     JSONB,
  storage_path    TEXT,
  size_bytes      BIGINT,
  downloaded_at   TIMESTAMPTZ DEFAULT NOW(),
  ip_address      TEXT,
  user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS idx_export_logs_package_id
  ON export_logs(package_id)
  WHERE package_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_export_logs_downloaded_at
  ON export_logs(downloaded_at);
