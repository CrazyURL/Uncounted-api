-- ── 005: Asset Ledger + Daily/Monthly Stats + Campaigns ──────────────────────
-- 자산 성장 엔진 핵심 테이블

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. user_asset_ledger — 모든 보상의 원장
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_asset_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  bu_id TEXT,                      -- BillableUnit 참조 (nullable)
  session_id TEXT,                 -- Session 참조 (nullable)
  ledger_type TEXT NOT NULL CHECK (ledger_type IN (
    'VOICE_BASE', 'LABEL_BONUS', 'COMPLIANCE_BONUS',
    'PROFILE_BONUS', 'TIER_BONUS', 'CAMPAIGN_REWARD', 'SALE_BONUS'
  )),
  amount_low INTEGER NOT NULL DEFAULT 0,    -- 보수적 추정 (₩)
  amount_high INTEGER NOT NULL DEFAULT 0,   -- 낙관적 추정 (₩)
  amount_confirmed INTEGER,                  -- 판매 확정 시 실제 금액 (NULL = 미확정)
  status TEXT NOT NULL DEFAULT 'estimated' CHECK (status IN ('estimated', 'confirmed', 'withdrawable', 'paid')),
  export_job_id TEXT,              -- 판매 연동 시 export_job 참조
  campaign_id TEXT,                -- 캠페인 보상 시 참조
  metadata JSONB,                  -- 추가 정보 (multiplier 값 등)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,        -- estimated → confirmed 시점
  withdrawable_at TIMESTAMPTZ,     -- confirmed → withdrawable 시점
  paid_at TIMESTAMPTZ              -- withdrawable → paid 시점
);

CREATE INDEX idx_ledger_user_id ON user_asset_ledger (user_id);
CREATE INDEX idx_ledger_type ON user_asset_ledger (ledger_type);
CREATE INDEX idx_ledger_bu_id ON user_asset_ledger (bu_id);
CREATE INDEX idx_ledger_created_date ON user_asset_ledger (user_id, (created_at::date));
CREATE INDEX idx_ledger_export_job ON user_asset_ledger (export_job_id) WHERE export_job_id IS NOT NULL;
CREATE INDEX idx_ledger_campaign ON user_asset_ledger (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX idx_ledger_status ON user_asset_ledger (user_id, status);

-- RLS: 단일 운영자 기준 open policy (v1)
ALTER TABLE user_asset_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ledger_all" ON user_asset_ledger FOR ALL USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. daily_asset_stats — 일별 집계
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS daily_asset_stats (
  user_id TEXT NOT NULL,
  date DATE NOT NULL,
  voice_base_low INTEGER NOT NULL DEFAULT 0,
  voice_base_high INTEGER NOT NULL DEFAULT 0,
  label_bonus_low INTEGER NOT NULL DEFAULT 0,
  label_bonus_high INTEGER NOT NULL DEFAULT 0,
  compliance_bonus_low INTEGER NOT NULL DEFAULT 0,
  compliance_bonus_high INTEGER NOT NULL DEFAULT 0,
  profile_bonus_low INTEGER NOT NULL DEFAULT 0,
  profile_bonus_high INTEGER NOT NULL DEFAULT 0,
  tier_bonus_low INTEGER NOT NULL DEFAULT 0,
  tier_bonus_high INTEGER NOT NULL DEFAULT 0,
  campaign_sum_low INTEGER NOT NULL DEFAULT 0,
  campaign_sum_high INTEGER NOT NULL DEFAULT 0,
  sale_bonus_confirmed INTEGER NOT NULL DEFAULT 0,
  total_estimated_low INTEGER NOT NULL DEFAULT 0,
  total_estimated_high INTEGER NOT NULL DEFAULT 0,
  total_confirmed INTEGER NOT NULL DEFAULT 0,
  bu_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE INDEX idx_daily_stats_date ON daily_asset_stats (date);

ALTER TABLE daily_asset_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "daily_stats_all" ON daily_asset_stats FOR ALL USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. monthly_asset_stats — 월별 집계
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS monthly_asset_stats (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,              -- 'YYYY-MM'
  total_estimated_low INTEGER NOT NULL DEFAULT 0,
  total_estimated_high INTEGER NOT NULL DEFAULT 0,
  total_confirmed INTEGER NOT NULL DEFAULT 0,
  bu_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  voice_base_low INTEGER NOT NULL DEFAULT 0,
  voice_base_high INTEGER NOT NULL DEFAULT 0,
  label_bonus_low INTEGER NOT NULL DEFAULT 0,
  label_bonus_high INTEGER NOT NULL DEFAULT 0,
  other_bonus_low INTEGER NOT NULL DEFAULT 0,
  other_bonus_high INTEGER NOT NULL DEFAULT 0,
  campaign_sum_low INTEGER NOT NULL DEFAULT 0,
  campaign_sum_high INTEGER NOT NULL DEFAULT 0,
  sale_bonus_confirmed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

ALTER TABLE monthly_asset_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "monthly_stats_all" ON monthly_asset_stats FOR ALL USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. campaigns — 캠페인 정의
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  title_ko TEXT NOT NULL,
  description_ko TEXT,
  condition JSONB NOT NULL DEFAULT '{}',    -- CampaignCondition
  target_bu_count INTEGER NOT NULL DEFAULT 0,
  current_bu_count INTEGER NOT NULL DEFAULT 0,
  bonus_rate_low INTEGER NOT NULL DEFAULT 0,  -- ₩/BU (low)
  bonus_rate_high INTEGER NOT NULL DEFAULT 0, -- ₩/BU (high)
  max_participants INTEGER,                   -- NULL = 무제한
  current_participants INTEGER NOT NULL DEFAULT 0,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('active', 'upcoming', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "campaigns_all" ON campaigns FOR ALL USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. campaign_progress — 사용자별 캠페인 참여 현황
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS campaign_progress (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  user_id TEXT NOT NULL,
  contributed_bu_count INTEGER NOT NULL DEFAULT 0,
  earned_low INTEGER NOT NULL DEFAULT 0,
  earned_high INTEGER NOT NULL DEFAULT 0,
  last_contributed_at TIMESTAMPTZ,
  PRIMARY KEY (campaign_id, user_id)
);

ALTER TABLE campaign_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "campaign_progress_all" ON campaign_progress FOR ALL USING (true) WITH CHECK (true);
