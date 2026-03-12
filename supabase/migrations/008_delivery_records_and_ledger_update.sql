-- ── 008: Delivery Records + Ledger 확장 ─────────────────────────────────────
-- Per-client 납품 이력 추적 + ledger_type/status 확장

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. delivery_records — Per-client 납품 이력 (중복 납품 방지)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS delivery_records (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  bu_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id),
  export_job_id TEXT NOT NULL REFERENCES export_jobs(id),
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(bu_id, client_id)
);

CREATE INDEX idx_delivery_client ON delivery_records (client_id);
CREATE INDEX idx_delivery_bu ON delivery_records (bu_id);
CREATE INDEX idx_delivery_job ON delivery_records (export_job_id);

ALTER TABLE delivery_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "delivery_records_all" ON delivery_records FOR ALL USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. user_asset_ledger 확장 — META_EVENT_BASE + voided 상태
-- ══════════════════════════════════════════════════════════════════════════════

-- ledger_type에 META_EVENT_BASE 추가
ALTER TABLE user_asset_ledger DROP CONSTRAINT IF EXISTS user_asset_ledger_ledger_type_check;
ALTER TABLE user_asset_ledger ADD CONSTRAINT user_asset_ledger_ledger_type_check
  CHECK (ledger_type IN (
    'VOICE_BASE', 'LABEL_BONUS', 'COMPLIANCE_BONUS',
    'PROFILE_BONUS', 'TIER_BONUS', 'CAMPAIGN_REWARD',
    'SALE_BONUS', 'META_EVENT_BASE'
  ));

-- status에 voided 추가 (estimated 취소용)
ALTER TABLE user_asset_ledger DROP CONSTRAINT IF EXISTS user_asset_ledger_status_check;
ALTER TABLE user_asset_ledger ADD CONSTRAINT user_asset_ledger_status_check
  CHECK (status IN ('estimated', 'confirmed', 'withdrawable', 'paid', 'voided'));

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. export_jobs 확장 — delivered 상태 추가
-- ══════════════════════════════════════════════════════════════════════════════

-- export_jobs.status에 delivered 추가 (기존 CHECK 제약 갱신)
-- 기존 제약이 없을 수 있으므로 안전하게 처리
DO $$
BEGIN
  ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. has_diarization 컬럼 추가 — 발음 상태 여부 추가
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS has_diarization BOOLEAN DEFAULT false;