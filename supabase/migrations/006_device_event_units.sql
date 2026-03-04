-- ── 006: Device Event Units + Stats ──────────────────────────────────────────
-- 메타 이벤트(Meta Event) 단위 시스템: 음성 BU와 병렬로 운영

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. device_event_units — 수확된 메타 이벤트 개별 건
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS device_event_units (
  id TEXT PRIMARY KEY,                -- evt_{skuId}_{dateBucket}_{timeBucket}_{idx}
  user_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,               -- U-M08, U-M09, U-M10 등
  event_type TEXT NOT NULL,           -- collector-specific event type
  date_bucket DATE NOT NULL,          -- YYYY-MM-DD
  time_bucket TEXT NOT NULL,          -- 00-02, 02-04, ...
  pseudo_id TEXT NOT NULL,            -- 비식별 기기 ID
  quality TEXT DEFAULT 'good' CHECK (quality IN ('good', 'partial', 'sparse')),
  harvested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deu_user_sku_date ON device_event_units (user_id, sku_id, date_bucket);
CREATE INDEX idx_deu_sku_id ON device_event_units (sku_id);

ALTER TABLE device_event_units ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deu_all" ON device_event_units FOR ALL USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. device_event_stats — SKU별 일별 집계
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS device_event_stats (
  user_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  date_bucket DATE NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  unique_time_buckets INTEGER NOT NULL DEFAULT 0,  -- 12개 중 몇 개 커버
  PRIMARY KEY (user_id, sku_id, date_bucket)
);

ALTER TABLE device_event_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "des_all" ON device_event_stats FOR ALL USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. 기존 테이블 확장 — unit_type + 메타 이벤트 집계 컬럼
-- ══════════════════════════════════════════════════════════════════════════════

-- user_asset_ledger: 음성/메타 구분
ALTER TABLE user_asset_ledger ADD COLUMN IF NOT EXISTS unit_type TEXT DEFAULT 'AUDIO_BU';

-- daily_asset_stats: 메타 이벤트 합계
ALTER TABLE daily_asset_stats ADD COLUMN IF NOT EXISTS meta_event_base_low INTEGER DEFAULT 0;
ALTER TABLE daily_asset_stats ADD COLUMN IF NOT EXISTS meta_event_base_high INTEGER DEFAULT 0;
ALTER TABLE daily_asset_stats ADD COLUMN IF NOT EXISTS event_count INTEGER DEFAULT 0;

-- monthly_asset_stats: 메타 이벤트 합계
ALTER TABLE monthly_asset_stats ADD COLUMN IF NOT EXISTS meta_event_base_low INTEGER DEFAULT 0;
ALTER TABLE monthly_asset_stats ADD COLUMN IF NOT EXISTS meta_event_base_high INTEGER DEFAULT 0;
ALTER TABLE monthly_asset_stats ADD COLUMN IF NOT EXISTS event_count INTEGER DEFAULT 0;
