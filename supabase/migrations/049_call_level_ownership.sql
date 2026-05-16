-- ============================================================
-- 049: Call-level Ownership v5 — 통화 단위 소유권 + 후보 매칭
-- 2026-05-04
-- ============================================================
-- 외부 컨설턴트 + 본 세션 5라운드 검토 + 본 세션 보완 5가지 반영.
--
-- 핵심 통찰:
--   1. "데이터는 사람 소유 X, 이벤트(call) 소유 O" — Call/Contract/Transaction 3분리
--   2. "fingerprint 완벽 X, 후보 조회 + 필터링 + ambiguity check"
--   3. "데이터 버리지 마라, 가치 낮추고 제한 걸어라" — PREMIUM/STANDARD/EXCLUDED
--   4. "merge 안 하되 묶을 수 있게 설계" — call_clusters 미사용 박음
--   5. "법보다 매수자 리스크 인식" — STANDARD 비식별화 전제
--
-- 048 (peer-level consent) 폐기:
--   - participants가 (contract_id, phone_hash) 단위로 peer 추적 자동 포괄
--   - peers 테이블에 consent 컬럼 박지 X (peers 테이블 자체는 다른 용도로 유지)
--
-- DDL 생성 순서 (FK 의존성):
--   1. calls → 2. contracts → 3. participants → 4. transactions
--   → 5. transaction_splits → 6. balances → 7. user_phone_history
--   → 8. ambiguous_matches → 9. call_clusters + members
--   → 10. ALTER sessions ADD call_id → 11. RLS → 12. 트리거 + 함수

-- ────────────────────────────────────────────────────────────
-- 1. calls (통화 단위 unique entity)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calls (
  call_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint TEXT NOT NULL UNIQUE,

  started_at TIMESTAMPTZ NOT NULL,                     -- 원본 보존
  started_at_minute_bucket BIGINT NOT NULL,            -- 분 단위
  started_at_quartile SMALLINT NOT NULL,               -- 0~3 (15초 단위)
  duration_seconds INT NOT NULL,
  duration_bucket INT NOT NULL,                        -- 5초 단위

  speakers_hash TEXT NOT NULL,                         -- HMAC(sorted normalized phones)
  caller_phone_normalized TEXT NOT NULL,
  callee_phone_normalized TEXT NOT NULL,
  caller_type TEXT NOT NULL CHECK (caller_type IN ('mobile','landline','virtual','corporate')),
  callee_type TEXT NOT NULL CHECK (callee_type IN ('mobile','landline','virtual','corporate')),

  grade TEXT NOT NULL CHECK (grade IN ('premium','standard','excluded')),

  status TEXT NOT NULL CHECK (status IN ('pending','sellable','sold','locked')) DEFAULT 'pending',
  sold_at TIMESTAMPTZ NULL,
  sold_to_buyer_id UUID NULL,
  sold_revenue_krw DECIMAL NULL,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 후보 조회 인덱스 (quartile ±1 + duration ±1 매칭용)
CREATE INDEX IF NOT EXISTS idx_calls_match
  ON calls(speakers_hash, started_at_minute_bucket, started_at_quartile, duration_bucket);
CREATE INDEX IF NOT EXISTS idx_calls_grade_status
  ON calls(grade, status) WHERE status IN ('pending','sellable');
CREATE INDEX IF NOT EXISTS idx_calls_sold
  ON calls(sold_at) WHERE sold_at IS NOT NULL;

COMMENT ON TABLE calls IS
  '통화 단위 unique entity. fingerprint = HMAC(minute_bucket-quartile-duration_bucket-speakers_hash). grade: PREMIUM(개인↔개인 모바일·유선) / STANDARD(기업·가상번호 1면) / EXCLUDED(거래 불가).';

-- ────────────────────────────────────────────────────────────
-- 2. contracts (call 단위 동의 계약)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contracts (
  contract_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL UNIQUE REFERENCES calls(call_id) ON DELETE RESTRICT,

  terms_version TEXT NOT NULL,                         -- "v1.1"
  status TEXT NOT NULL CHECK (status IN ('pending','agreed','executed')),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  agreed_at TIMESTAMPTZ NULL,
  executed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_contracts_call ON contracts(call_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status
  ON contracts(status) WHERE status IN ('pending','agreed');

-- ────────────────────────────────────────────────────────────
-- 3. participants (권리자 — phone_hash + user_id nullable)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS participants (
  contract_id UUID REFERENCES contracts(contract_id) ON DELETE CASCADE,
  phone_hash TEXT NOT NULL,
  user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,  -- 미가입자면 NULL

  consent_status TEXT NOT NULL CHECK (consent_status IN ('pending','agreed','rejected','withdrawn')),
  consent_agreed_at TIMESTAMPTZ NULL,
  consent_ip TEXT NULL,
  consent_user_agent TEXT NULL,
  consent_terms_version TEXT NULL,

  revenue_share DECIMAL NOT NULL DEFAULT 50.0,
  revenue_share_basis TEXT NOT NULL DEFAULT 'standard',
  -- 'standard' (PREMIUM 50:50) / 'sole' (STANDARD 100%) / 'corporate_partner' / 'platform_adjusted'

  PRIMARY KEY (contract_id, phone_hash)
);

CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_participants_phone ON participants(phone_hash);

-- ────────────────────────────────────────────────────────────
-- 4. transactions (거래 + payout hold)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transactions (
  tx_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL REFERENCES calls(call_id) ON DELETE RESTRICT,

  buyer_id UUID NOT NULL,                              -- 050에서 buyers FK 박음
  price DECIMAL NOT NULL,

  sold_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payout_release_at TIMESTAMPTZ NOT NULL,              -- 다음달 15일

  status TEXT NOT NULL CHECK (status IN ('hold','released')) DEFAULT 'hold',
  released_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_release
  ON transactions(payout_release_at) WHERE status = 'hold';
CREATE INDEX IF NOT EXISTS idx_transactions_call ON transactions(call_id);

-- ────────────────────────────────────────────────────────────
-- 5. transaction_splits (분배 스냅샷)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transaction_splits (
  tx_id UUID REFERENCES transactions(tx_id) ON DELETE CASCADE,
  participant_phone_hash TEXT NOT NULL,
  participant_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,

  share_percent DECIMAL NOT NULL,
  share_amount DECIMAL NOT NULL,
  split_basis TEXT NOT NULL,
  -- 'standard' / 'sole' / 'corporate_partner' / 'platform_adjusted'

  PRIMARY KEY (tx_id, participant_phone_hash)
);

CREATE INDEX IF NOT EXISTS idx_splits_user
  ON transaction_splits(participant_user_id) WHERE participant_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_splits_phone ON transaction_splits(participant_phone_hash);

-- ────────────────────────────────────────────────────────────
-- 6. balances (사용자 잔액 — pending + available 2단계)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS balances (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  pending DECIMAL DEFAULT 0,
  available DECIMAL DEFAULT 0,

  total_earned DECIMAL DEFAULT 0,                      -- 누적 수익 (회계용)
  total_withdrawn DECIMAL DEFAULT 0,                   -- 누적 출금

  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────
-- 7. user_phone_history (이전 번호 매칭 + 3개 제한)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_phone_history (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_hash TEXT NOT NULL,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  is_current BOOLEAN DEFAULT FALSE,

  PRIMARY KEY (user_id, phone_hash)
);

CREATE INDEX IF NOT EXISTS idx_phone_history_hash ON user_phone_history(phone_hash);

-- 같은 user의 is_current=TRUE는 한 개만 (매칭 모호 제거)
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_history_current
  ON user_phone_history(user_id)
  WHERE is_current = TRUE;

-- ────────────────────────────────────────────────────────────
-- 8. ambiguous_matches (false split flag + audit log)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ambiguous_matches (
  match_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  new_call_id UUID NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  candidate_call_ids UUID[] NOT NULL,
  ambiguity_ratio DECIMAL NOT NULL,
  reason TEXT NOT NULL,

  -- M3 이후 batch job용
  auto_merge_candidate BOOLEAN DEFAULT FALSE,
  auto_merge_score DECIMAL NULL,
  merge_reason TEXT NULL,

  flagged_for_review BOOLEAN DEFAULT TRUE,
  reviewed_at TIMESTAMPTZ NULL,
  reviewer_decision TEXT NULL,                         -- 'kept_separate' / 'merged_to_X'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ambiguous_review
  ON ambiguous_matches(flagged_for_review) WHERE flagged_for_review = TRUE;

-- ────────────────────────────────────────────────────────────
-- 9. call_clusters (M3+ 활성화. 지금 미사용)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_clusters (
  cluster_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_call_id UUID NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  cluster_type TEXT NOT NULL CHECK (cluster_type IN ('manual','auto','pending_review')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_cluster_members (
  cluster_id UUID REFERENCES call_clusters(cluster_id) ON DELETE CASCADE,
  call_id UUID REFERENCES calls(call_id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (cluster_id, call_id)
);

-- ────────────────────────────────────────────────────────────
-- 10. ALTER sessions ADD call_id (legacy 데이터 매핑)
-- ────────────────────────────────────────────────────────────
-- 신규 upload부터 자동 매핑. dev DB clean slate라 backfill X.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS call_id UUID NULL REFERENCES calls(call_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_call ON sessions(call_id) WHERE call_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- 11. RLS (SELECT + INSERT/UPDATE 명시)
-- ────────────────────────────────────────────────────────────

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_phone_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ambiguous_matches ENABLE ROW LEVEL SECURITY;

-- 사용자 SELECT 권한
DROP POLICY IF EXISTS "users_own_balance" ON balances;
CREATE POLICY "users_own_balance" ON balances
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_own_participants_select" ON participants;
CREATE POLICY "users_own_participants_select" ON participants
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_own_phone_history" ON user_phone_history;
CREATE POLICY "users_own_phone_history" ON user_phone_history
  FOR ALL USING (auth.uid() = user_id);

-- 사용자 UPDATE 권한 (consent_status 변경)
DROP POLICY IF EXISTS "users_update_own_consent" ON participants;
CREATE POLICY "users_update_own_consent" ON participants
  FOR UPDATE USING (auth.uid() = user_id);

-- service_role only — 잔액·계약·거래·분배·통화·모호매칭은 백엔드만 박음
DROP POLICY IF EXISTS "service_role_balance_write" ON balances;
CREATE POLICY "service_role_balance_write" ON balances
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "service_role_calls" ON calls;
CREATE POLICY "service_role_calls" ON calls
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "service_role_contracts" ON contracts;
CREATE POLICY "service_role_contracts" ON contracts
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "service_role_transactions" ON transactions;
CREATE POLICY "service_role_transactions" ON transactions
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "service_role_splits" ON transaction_splits;
CREATE POLICY "service_role_splits" ON transaction_splits
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "service_role_ambiguous" ON ambiguous_matches;
CREATE POLICY "service_role_ambiguous" ON ambiguous_matches
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "service_role_participants_insert" ON participants;
CREATE POLICY "service_role_participants_insert" ON participants
  FOR INSERT WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

-- ────────────────────────────────────────────────────────────
-- 12. 트리거 + 함수
-- ────────────────────────────────────────────────────────────

-- phone_history 최대 3개 제한 (시드 단계 정책, M6+ 확장 가능)
CREATE OR REPLACE FUNCTION enforce_phone_history_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM user_phone_history WHERE user_id = NEW.user_id) >= 3 THEN
    RAISE EXCEPTION '전화번호는 최대 3개까지 등록 가능합니다 (user_id=%)', NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS phone_history_limit ON user_phone_history;
CREATE TRIGGER phone_history_limit
  BEFORE INSERT ON user_phone_history
  FOR EACH ROW EXECUTE FUNCTION enforce_phone_history_limit();

-- ────────────────────────────────────────────────────────────
-- 코멘트
-- ────────────────────────────────────────────────────────────

COMMENT ON COLUMN calls.fingerprint IS
  'sha256(minute_bucket-quartile-duration_bucket-speakers_hash). 후보 매칭은 quartile ±1 + duration ±1로 조회 후 ambiguity check (ratio < 0.20 → 새 call).';
COMMENT ON COLUMN calls.grade IS
  'PREMIUM(50:50 분배) / STANDARD(개인 측 100%, 비식별화 의무) / EXCLUDED(거래 불가).';
COMMENT ON COLUMN calls.status IS
  'pending(uploader 단독) / sellable(모든 participants agreed) / sold(거래 완료) / locked(분쟁).';
COMMENT ON COLUMN participants.revenue_share_basis IS
  'standard(PREMIUM 50:50) / sole(STANDARD 100%) / corporate_partner / platform_adjusted.';
COMMENT ON COLUMN transactions.payout_release_at IS
  '다음달 15일 (시드 정책). calculateReleaseDate(soldAt) 함수로 계산. 매수자 LOI 시 AI Hub 표준 30일과 비교 재검토.';
COMMENT ON TABLE ambiguous_matches IS
  'best vs second delta ratio < 0.20일 때 새 call로 등록 + 본 테이블에 audit. M0~M3 매주 수동 검토 → M3~M6 batch job → M6+ LOI 후 자동 cron.';
COMMENT ON TABLE call_clusters IS
  'soft merge 레이어. M3+ batch job 활성화. canonical_call_id가 cluster 대표 통화.';
COMMENT ON COLUMN sessions.call_id IS
  '신규 upload부터 자동 매핑. legacy backfill X (dev DB clean slate). NULL이면 아직 call entity로 정규화 X (예: STANDARD pending 또는 EXCLUDED).';
