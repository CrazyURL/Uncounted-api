-- ============================================================
-- Uncounted Migration v3 — Admin Console vNext
-- Billable Units + Clients + Export Jobs + SKU Components
-- ============================================================

-- ── 1. billable_units (세션에서 파생, 유효 1분 = 정산 단위) ────────────────
CREATE TABLE IF NOT EXISTS billable_units (
  id                 TEXT PRIMARY KEY,          -- session_id + '_' + minute_index
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  minute_index       INTEGER NOT NULL,          -- 0-based
  effective_seconds  NUMERIC(6,2) NOT NULL,     -- 이 구간의 유효 초 (최대 60)
  quality_grade      TEXT NOT NULL DEFAULT 'C', -- A/B/C
  qa_score           INTEGER NOT NULL DEFAULT 0,
  quality_tier       TEXT NOT NULL DEFAULT 'basic', -- basic/verified/gold
  label_source       TEXT,                      -- auto/user/user_confirmed/multi_confirmed
  has_labels         BOOLEAN NOT NULL DEFAULT false,
  consent_status     TEXT NOT NULL DEFAULT 'PRIVATE',
  pii_status         TEXT NOT NULL DEFAULT 'CLEAR',
  lock_status        TEXT NOT NULL DEFAULT 'available', -- available/locked_for_job/delivered
  locked_by_job_id   TEXT,
  session_date       TEXT NOT NULL,             -- YYYY-MM-DD (denormalized)
  user_id            UUID,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (session_id, minute_index)
);

CREATE INDEX IF NOT EXISTS idx_bu_session    ON billable_units(session_id);
CREATE INDEX IF NOT EXISTS idx_bu_quality    ON billable_units(quality_grade);
CREATE INDEX IF NOT EXISTS idx_bu_tier       ON billable_units(quality_tier);
CREATE INDEX IF NOT EXISTS idx_bu_lock       ON billable_units(lock_status);
CREATE INDEX IF NOT EXISTS idx_bu_consent    ON billable_units(consent_status);
CREATE INDEX IF NOT EXISTS idx_bu_date       ON billable_units(session_date DESC);
CREATE INDEX IF NOT EXISTS idx_bu_user       ON billable_units(user_id);

-- ── 2. clients (납품처) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  contact_name    TEXT,
  contact_email   TEXT,
  notes           TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. delivery_profiles (납품 프로필) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_profiles (
  id                         TEXT PRIMARY KEY,
  client_id                  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name                       TEXT NOT NULL,
  format                     TEXT NOT NULL DEFAULT 'jsonl',
  fieldset                   JSONB NOT NULL DEFAULT '[]',
  channel_ko                 TEXT DEFAULT '직접 전달',
  requires_pii_cleaned       BOOLEAN DEFAULT false,
  requires_consent_verified  BOOLEAN DEFAULT true,
  min_quality_grade          TEXT,
  notes                      TEXT,
  created_at                 TIMESTAMPTZ DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dp_client ON delivery_profiles(client_id);

-- ── 4. client_sku_rules (고객별 허용 SKU + 옵션) ──────────────────────────
CREATE TABLE IF NOT EXISTS client_sku_rules (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sku_id            TEXT NOT NULL,
  component_ids     JSONB NOT NULL DEFAULT '["BASIC"]',
  max_units_month   INTEGER,
  price_per_unit    INTEGER,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, sku_id)
);

CREATE INDEX IF NOT EXISTS idx_csr_client ON client_sku_rules(client_id);

-- ── 5. export_jobs (빌드/납품 작업) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS export_jobs (
  id                   TEXT PRIMARY KEY,
  client_id            TEXT REFERENCES clients(id) ON DELETE SET NULL,
  sku_id               TEXT NOT NULL,
  component_ids        JSONB NOT NULL DEFAULT '["BASIC"]',
  delivery_profile_id  TEXT REFERENCES delivery_profiles(id) ON DELETE SET NULL,
  requested_units      INTEGER NOT NULL,
  actual_units         INTEGER NOT NULL DEFAULT 0,
  sampling_strategy    TEXT NOT NULL DEFAULT 'all',
  filters              JSONB NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'draft',
  selection_manifest   JSONB,                    -- v1: 선택된 unit ID 배열
  output_format        TEXT NOT NULL DEFAULT 'jsonl',
  logs                 JSONB NOT NULL DEFAULT '[]',
  error_message        TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ej_status  ON export_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ej_client  ON export_jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_ej_created ON export_jobs(created_at DESC);

-- ── 6. RLS (단일 운영자, 최소 정책) ───────────────────────────────────────

ALTER TABLE billable_units ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bu_all" ON billable_units FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "clients_all" ON clients FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE delivery_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dp_all" ON delivery_profiles FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE client_sku_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "csr_all" ON client_sku_rules FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ej_all" ON export_jobs FOR ALL USING (true) WITH CHECK (true);
