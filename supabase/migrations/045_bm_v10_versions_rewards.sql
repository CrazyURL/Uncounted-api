-- BM v10.0 — 코호트 v 회전 + 순이익 50:50 + Cap ₩300만 + 잉여 이월 (2026-05-01)
--
-- BM v10.0 정식 채택 (Cap ₩300만 / 순이익 50:50 / 시드 20명 / 4단계 SKU) 정합 인프라.
--
-- 신규 5개 테이블:
--   1. data_versions          — 600h 단위 v 코호트 (선가입자 우선 + 신선도 차등)
--   2. version_contributors   — v별 화자 기여 (priority_index = 가입 순서)
--   3. user_reward_log        — 보상 지급 로그 (역년 + Cap 추적)
--   4. kept_data_pool         — 잉여 데이터 (Cap 도달 후 다음 v 이월)
--   5. operating_cost_quarterly — 분기별 운영비 결산 (분배 산정 입력 + 공개 의무 제13조 6항)
--
-- 약관 v1.1 정합:
--   - 제2조 (데이터 버전 v / 신선도 차등 / Cap / 잉여 데이터 / 선가입자 우선)
--   - 제10조 (600h 단위 / 비독점 N회 5~10회)
--   - 제11조 (순이익 50:50 / Cap ₩300만 / 매년 1월 리셋 / 잉여 이월)
--   - 제13조 (분기 운영비 결산 + 외부 감사)
--   - 제18조 (운영비 정의 + 경영진 보수 한도 + 이의제기권)
--
-- 본 마이그레이션은 인프라 스키마만 — 분배 알고리즘 v0.6 (TypeScript)는 별도 작업.

-- ──────────────────────────────────────────────────────────────────────
-- 1. data_versions — 600h 단위 v 코호트
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_versions (
  version_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_number      INTEGER NOT NULL UNIQUE,           -- v1, v2, v3 ... 순번
  cohort_period_start TIMESTAMPTZ NOT NULL,              -- 첫 발화 시점
  cohort_period_end   TIMESTAMPTZ NOT NULL,              -- 마지막 발화 시점 (sealed 시점)
  total_hours         NUMERIC(10, 2) NOT NULL,           -- 600.00 표준 (시드 단계는 6/60도 가능)

  -- 신선도 차등 (vN > vN-1 > vN-3)
  freshness_quartile  INTEGER NOT NULL CHECK (freshness_quartile BETWEEN 1 AND 4),
  -- 1=최신 (프리미엄) / 2=직전 / 3=중간 / 4=가장 오래 (할인)

  -- 라이프사이클
  status              TEXT NOT NULL CHECK (status IN ('pending', 'sealed', 'sold', 'archived')),
  -- pending: 600h 미달, 누적 중
  -- sealed: 600h 도달, 판매 가능
  -- sold: N회 판매 완료 (5~10회 상한 도달 또는 매수자 만료)
  -- archived: 신선도 4분기 경과, 매출 종료

  -- SKU 단계 (UC-A1/A2/A3/LLM)
  sku_tier            TEXT NOT NULL CHECK (sku_tier IN ('UC-A1', 'UC-A2', 'UC-A3', 'UC-LLM')),

  -- 동질성 샘플링 메타 (코호트 분포)
  family_pct          NUMERIC(5, 2),  -- 가족 통화 %
  friend_pct          NUMERIC(5, 2),  -- 친구 통화 %
  business_pct        NUMERIC(5, 2),  -- 업무 통화 %
  -- family_pct + friend_pct + business_pct = 100 권장 (기타는 fallback)

  -- 판매 회차
  sold_count          INTEGER NOT NULL DEFAULT 0,
  max_sold_count      INTEGER NOT NULL DEFAULT 10,       -- 비독점 N회 상한 (5~10)

  sealed_at           TIMESTAMPTZ,
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_versions_status_freshness
  ON data_versions (status, freshness_quartile)
  WHERE status IN ('sealed', 'sold');

CREATE INDEX IF NOT EXISTS idx_data_versions_sku_tier
  ON data_versions (sku_tier, status);

COMMENT ON TABLE data_versions IS
  'BM v10.0 코호트 v 단위 (600h 단위 자동 분리). 약관 v1.1 제2조·제10조 정합.';

COMMENT ON COLUMN data_versions.freshness_quartile IS
  '신선도 차등 (1=최신 프리미엄, 4=오래 할인). 단가 차등 입력.';

COMMENT ON COLUMN data_versions.sold_count IS
  '비독점 N회 판매 카운트. max_sold_count 도달 시 archived 전환.';

-- ──────────────────────────────────────────────────────────────────────
-- 2. version_contributors — v별 화자 기여 (선가입자 우선)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS version_contributors (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id          UUID NOT NULL REFERENCES data_versions(version_id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 선가입자 우선 정렬 키
  signup_at           TIMESTAMPTZ NOT NULL,                        -- 가입 시점 스냅샷
  priority_index      INTEGER NOT NULL,                            -- 1=가장 먼저 가입 (코호트 내 순위)

  -- 시간 비례 분배 입력
  contributed_hours   NUMERIC(8, 2) NOT NULL CHECK (contributed_hours > 0),

  -- 통화 유형 분포 (동질성 샘플링 입력)
  family_hours        NUMERIC(8, 2) NOT NULL DEFAULT 0,
  friend_hours        NUMERIC(8, 2) NOT NULL DEFAULT 0,
  business_hours      NUMERIC(8, 2) NOT NULL DEFAULT 0,
  other_hours         NUMERIC(8, 2) NOT NULL DEFAULT 0,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (version_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_version_contributors_user
  ON version_contributors (user_id);

CREATE INDEX IF NOT EXISTS idx_version_contributors_priority
  ON version_contributors (version_id, priority_index);

COMMENT ON TABLE version_contributors IS
  'v별 화자 기여 + 선가입자 우선 (priority_index). 약관 v1.1 제11조 2항 분배 입력.';

-- ──────────────────────────────────────────────────────────────────────
-- 3. user_reward_log — 보상 지급 로그 + Cap 추적
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_reward_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version_id               UUID NOT NULL REFERENCES data_versions(version_id),

  -- 역년 (Cap 리셋 단위)
  fiscal_year              INTEGER NOT NULL,                       -- 2026, 2027 ...

  -- 지급 금액
  amount_krw               NUMERIC(12, 0) NOT NULL CHECK (amount_krw >= 0),

  -- Cap 메타 (지급 시점 스냅샷)
  yearly_cap_at_time       NUMERIC(12, 0) NOT NULL DEFAULT 3000000,
  yearly_cap_reached       BOOLEAN NOT NULL DEFAULT FALSE,         -- 본 지급으로 Cap 도달했는지

  -- 22% 원천징수 (분리과세 6% + 부가세 등)
  withholding_pct          NUMERIC(4, 2) NOT NULL DEFAULT 22.00,
  net_paid_krw             NUMERIC(12, 0) NOT NULL,                -- 실수령액 = amount × (1 - withholding/100)

  -- 정산 시점
  settled_for_month        DATE NOT NULL,                          -- 해당 월 (말일 마감)
  paid_at                  TIMESTAMPTZ,                            -- 다음달 15일 자동 송금

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_user_year
  ON user_reward_log (user_id, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_reward_settled_month
  ON user_reward_log (settled_for_month);

CREATE INDEX IF NOT EXISTS idx_reward_cap_reached
  ON user_reward_log (user_id, fiscal_year)
  WHERE yearly_cap_reached = TRUE;

COMMENT ON TABLE user_reward_log IS
  '화자 보상 지급 로그. 약관 v1.1 제11조 (Cap ₩300만 + 22% 원천징수 + 매월 정산).';

COMMENT ON COLUMN user_reward_log.fiscal_year IS
  '역년 (1월 1일~12월 31일). Cap 리셋 단위.';

-- ──────────────────────────────────────────────────────────────────────
-- 4. kept_data_pool — 잉여 데이터 (Cap 도달 후 다음 v 이월)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kept_data_pool (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utterance_id        UUID NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 이월 사유
  reason              TEXT NOT NULL CHECK (reason IN ('cap_reached', 'pending_v', 'archived_v')),
  -- cap_reached: 화자 Cap 도달 → 다음 역년 또는 다음 v로 이월
  -- pending_v: 600h 미달, 누적 대기
  -- archived_v: v archived 됐으나 화자 Cap 잔여 있음 → 신규 v 이월

  duration_sec        NUMERIC(8, 2) NOT NULL CHECK (duration_sec > 0),
  source_version_id   UUID REFERENCES data_versions(version_id),  -- 이월 출처 (NULL = pending)

  next_eligible_after TIMESTAMPTZ,                               -- 이 시점 이후 다음 v 진입 가능 (역년 보존 X)
  consumed            BOOLEAN NOT NULL DEFAULT FALSE,            -- 다음 v에 진입 완료
  consumed_at         TIMESTAMPTZ,
  target_version_id   UUID REFERENCES data_versions(version_id), -- 진입한 v

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kept_pool_user_unconsumed
  ON kept_data_pool (user_id, next_eligible_after)
  WHERE consumed = FALSE;

CREATE INDEX IF NOT EXISTS idx_kept_pool_reason
  ON kept_data_pool (reason, consumed);

COMMENT ON TABLE kept_data_pool IS
  '잉여 데이터 (Cap 도달 후 다음 v 이월). 약관 v1.1 제11조 4항 (영구 자산화).';

-- ──────────────────────────────────────────────────────────────────────
-- 5. operating_cost_quarterly — 분기별 운영비 결산 (제13조 6항 + 제18조)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS operating_cost_quarterly (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year         INTEGER NOT NULL,                         -- 2026, 2027 ...
  quarter             INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),

  -- 매출 (해당 분기 v 판매 매출 합계)
  revenue_krw         NUMERIC(14, 0) NOT NULL DEFAULT 0,

  -- 운영비 항목별 (제18조 1항 통상 사업비)
  cost_personnel      NUMERIC(14, 0) NOT NULL DEFAULT 0,        -- 인건비 (경영진 보수 포함, 제18조 2항 한도)
  cost_infrastructure NUMERIC(14, 0) NOT NULL DEFAULT 0,        -- GPU·클라우드·DB·CDN·외부 API
  cost_legal          NUMERIC(14, 0) NOT NULL DEFAULT 0,        -- 법무·세무·노무 자문
  cost_marketing      NUMERIC(14, 0) NOT NULL DEFAULT 0,        -- 광고·콘텐츠
  cost_speaker_acq    NUMERIC(14, 0) NOT NULL DEFAULT 0,        -- 가입 사례비·추천 인센티브
  cost_audit          NUMERIC(14, 0) NOT NULL DEFAULT 0,        -- 외부 회계 감사 (10K+ 시점)
  cost_other          NUMERIC(14, 0) NOT NULL DEFAULT 0,        -- 기타 통상 비용 (메모 필수)
  cost_other_memo     TEXT,

  -- 비통상 비용 (제18조 3항 — 회사 유보 50%에서 별도 처리, 화자 풀 영향 X)
  non_operating_cost  NUMERIC(14, 0) NOT NULL DEFAULT 0,
  non_operating_memo  TEXT,

  -- 산출 (GENERATED)
  total_operating_cost NUMERIC(14, 0)
    GENERATED ALWAYS AS (
      cost_personnel + cost_infrastructure + cost_legal +
      cost_marketing + cost_speaker_acq + cost_audit + cost_other
    ) STORED,
  net_profit_krw      NUMERIC(14, 0)
    GENERATED ALWAYS AS (
      revenue_krw - (cost_personnel + cost_infrastructure + cost_legal +
                     cost_marketing + cost_speaker_acq + cost_audit + cost_other)
    ) STORED,
  company_retention   NUMERIC(14, 0)
    GENERATED ALWAYS AS (
      GREATEST(
        (revenue_krw - (cost_personnel + cost_infrastructure + cost_legal +
                        cost_marketing + cost_speaker_acq + cost_audit + cost_other)) / 2,
        0
      )
    ) STORED,
  speaker_pool_krw    NUMERIC(14, 0)
    GENERATED ALWAYS AS (
      GREATEST(
        (revenue_krw - (cost_personnel + cost_infrastructure + cost_legal +
                        cost_marketing + cost_speaker_acq + cost_audit + cost_other)) / 2,
        0
      )
    ) STORED,

  -- 공개 의무 (제13조 6항)
  closed_at           TIMESTAMPTZ,                              -- 분기 마감
  published_at        TIMESTAMPTZ,                              -- 사용자 대시보드 공개 시점 (마감 + 30일 내)
  audit_report_url    TEXT,                                     -- 외부 감사 보고서 (10K+ 시점)

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (fiscal_year, quarter)
);

CREATE INDEX IF NOT EXISTS idx_opcost_year_quarter
  ON operating_cost_quarterly (fiscal_year DESC, quarter DESC);

CREATE INDEX IF NOT EXISTS idx_opcost_published
  ON operating_cost_quarterly (published_at)
  WHERE published_at IS NOT NULL;

COMMENT ON TABLE operating_cost_quarterly IS
  '분기별 운영비 결산. 약관 v1.1 제13조 6항 + 제18조 (분기 결산 공개 + 외부 감사).';

COMMENT ON COLUMN operating_cost_quarterly.net_profit_krw IS
  '순이익 = 매출 - 통상 운영비. 음수 시 화자 풀 0 (제11조 1항 손실 분기 분배 없음).';

COMMENT ON COLUMN operating_cost_quarterly.speaker_pool_krw IS
  '화자 보상 풀 = 순이익 × 50% (음수 시 0). 분배 알고리즘 v0.6 입력.';

-- ──────────────────────────────────────────────────────────────────────
-- 6. RLS (Row Level Security) — 사용자는 본인 데이터만 조회
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE version_contributors ENABLE ROW LEVEL SECURITY;
CREATE POLICY version_contributors_self_select
  ON version_contributors FOR SELECT
  USING (auth.uid() = user_id);

ALTER TABLE user_reward_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_reward_log_self_select
  ON user_reward_log FOR SELECT
  USING (auth.uid() = user_id);

ALTER TABLE kept_data_pool ENABLE ROW LEVEL SECURITY;
CREATE POLICY kept_data_pool_self_select
  ON kept_data_pool FOR SELECT
  USING (auth.uid() = user_id);

-- data_versions / operating_cost_quarterly 는 공개 정보 (분배 알고리즘 + 운영비 결산 공개 의무)
-- → RLS 활성화 + SELECT 모두 허용 (anon 포함)
ALTER TABLE data_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_versions_public_select
  ON data_versions FOR SELECT
  USING (TRUE);

ALTER TABLE operating_cost_quarterly ENABLE ROW LEVEL SECURITY;
CREATE POLICY opcost_public_select
  ON operating_cost_quarterly FOR SELECT
  USING (published_at IS NOT NULL);  -- 공개된 결산만 조회 가능

-- ──────────────────────────────────────────────────────────────────────
-- 7. 운영 헬퍼 함수
-- ──────────────────────────────────────────────────────────────────────

-- 사용자 본인의 역년 누적 보상 합계 (Cap 잔여 계산용)
CREATE OR REPLACE FUNCTION user_yearly_reward_total(
  p_user_id UUID,
  p_fiscal_year INTEGER
) RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(amount_krw), 0)
  FROM user_reward_log
  WHERE user_id = p_user_id
    AND fiscal_year = p_fiscal_year;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

COMMENT ON FUNCTION user_yearly_reward_total IS
  '사용자의 해당 역년 누적 보상 합계. Cap 잔여 = ₩3,000,000 - 본 함수 결과.';

-- v 신선도 자동 계산 (vN > vN-1 > vN-3)
CREATE OR REPLACE FUNCTION calculate_freshness_quartile(
  p_version_number INTEGER,
  p_max_version INTEGER
) RETURNS INTEGER AS $$
DECLARE
  v_age INTEGER;
BEGIN
  v_age := p_max_version - p_version_number;
  IF v_age <= 0 THEN RETURN 1;       -- 최신
  ELSIF v_age <= 2 THEN RETURN 2;    -- 직전
  ELSIF v_age <= 5 THEN RETURN 3;    -- 중간
  ELSE RETURN 4;                      -- 오래 (할인)
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION calculate_freshness_quartile IS
  '신선도 분기 계산 (최신=1, 1~2 차이=2, 3~5=3, 6+=4). 단가 차등 입력.';
