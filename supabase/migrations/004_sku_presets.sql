-- ============================================================
-- Uncounted Migration v4 — SKU Presets (커스텀 SKU 구성)
-- ============================================================

CREATE TABLE IF NOT EXISTS sku_presets (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  base_sku_id             TEXT NOT NULL,           -- U-A01 등 기본 SKU ID
  component_ids           JSONB NOT NULL DEFAULT '["BASIC"]',
  -- 소스 필터
  require_audio           BOOLEAN NOT NULL DEFAULT true,
  require_labels          JSONB NOT NULL DEFAULT 'false',  -- false | true | ["field1","field2"]
  label_value_filter      JSONB NOT NULL DEFAULT '{}',    -- {"relationship":["동료","고객"],"domain":["비즈니스"]}
  require_consent         BOOLEAN NOT NULL DEFAULT true,
  require_pii_cleaned     BOOLEAN NOT NULL DEFAULT false,
  min_quality_grade       TEXT,                    -- A/B/C or null
  domain_filter           JSONB NOT NULL DEFAULT '[]',     -- ["비즈니스","기술"] or []
  -- 출력 설정
  export_fields           JSONB NOT NULL DEFAULT '[]',     -- EXPORT_FIELD_CATALOG key 배열
  preferred_format        TEXT NOT NULL DEFAULT 'jsonl',   -- json/jsonl/csv
  -- 가격/메타
  suggested_price_per_unit INTEGER,                -- ₩/unit 참고 단가
  notes                   TEXT,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sp_sku    ON sku_presets(base_sku_id);
CREATE INDEX IF NOT EXISTS idx_sp_active ON sku_presets(is_active);

ALTER TABLE sku_presets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sp_all" ON sku_presets FOR ALL USING (true) WITH CHECK (true);

-- client_sku_rules에 프리셋 참조 + 할인율 컬럼 추가
ALTER TABLE client_sku_rules ADD COLUMN IF NOT EXISTS preset_id TEXT REFERENCES sku_presets(id) ON DELETE SET NULL;
ALTER TABLE client_sku_rules ADD COLUMN IF NOT EXISTS discount_pct INTEGER NOT NULL DEFAULT 0;  -- 납품처별 할인율 0~100
