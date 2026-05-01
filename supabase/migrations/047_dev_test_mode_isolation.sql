-- BM v10.0 — DEV flavor 데이터 격리 (2026-05-01, plan v10.6 정정 2)
--
-- v10.5의 "Build flavor 가드"는 UI 격리만 박힘. DB 격리 추가:
--   - DEV 토글로 승격된 데이터 = is_test_mode=true
--   - live flavor 통계·packageBuilder에서 자동 제외
--   - LeeGoGke 본인 DEV 테스트 → live 진입 시 별도 결정 (migration 048)
--
-- 정합:
--   - 약관 v1.1 제10조 (4단계 SKU): test mode 데이터는 매수자 패키지 제외
--   - plan v10.6 수정 2 (DB 격리)

-- ── 1. data_versions / version_contributors / user_reward_log에 is_test_mode 컬럼 ──
ALTER TABLE data_versions
  ADD COLUMN IF NOT EXISTS is_test_mode BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE version_contributors
  ADD COLUMN IF NOT EXISTS is_test_mode BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE user_reward_log
  ADD COLUMN IF NOT EXISTS is_test_mode BOOLEAN NOT NULL DEFAULT false;

-- ── 2. consent_invitations.consent_method enum 확장 ─────────────────────
-- 기존 NULL 또는 'app' / 'web' (게이트 C+ 자산)에 'manual_dev_test' 추가
ALTER TABLE consent_invitations
  ADD COLUMN IF NOT EXISTS consent_method TEXT
    CHECK (consent_method IS NULL OR consent_method IN ('app', 'web', 'manual_dev_test'));

-- ── 3. 인덱스 — live 빌드 query에서 is_test_mode=false 자동 필터 ──────
CREATE INDEX IF NOT EXISTS idx_data_versions_live
  ON data_versions(version_number)
  WHERE is_test_mode = false;

CREATE INDEX IF NOT EXISTS idx_reward_log_live
  ON user_reward_log(user_id, fiscal_year)
  WHERE is_test_mode = false;

CREATE INDEX IF NOT EXISTS idx_version_contributors_live
  ON version_contributors(version_id, priority_index)
  WHERE is_test_mode = false;

-- ── 4. 코멘트 ──────────────────────────────────────────────────────────
COMMENT ON COLUMN data_versions.is_test_mode IS
  'DEV flavor 토글로 발급된 테스트 v. 매수자 패키지에 자동 제외. live 빌드 통계에서 분리. plan v10.6 수정 2.';

COMMENT ON COLUMN version_contributors.is_test_mode IS
  'data_versions.is_test_mode 정합. test v의 contributor.';

COMMENT ON COLUMN user_reward_log.is_test_mode IS
  'test v 분배 시 발생한 보상 로그. live 빌드 Cap 진행률 산정에서 제외.';

COMMENT ON COLUMN consent_invitations.consent_method IS
  'app=앱 PeerConsentPage, web=peer.html, manual_dev_test=DEV 토글로 시뮬레이션 동의. 시드 검증 단계 구분.';

-- ── 5. user_yearly_reward_total 함수 갱신 — live_only 옵션 ────────────
-- 기존 함수: 모든 reward 합산 (test 포함)
-- 신규: live_only=true 옵션 시 is_test_mode=false만 합산

CREATE OR REPLACE FUNCTION user_yearly_reward_total(
  p_user_id UUID,
  p_fiscal_year INTEGER,
  p_live_only BOOLEAN DEFAULT FALSE
) RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(amount_krw), 0)
  FROM user_reward_log
  WHERE user_id = p_user_id
    AND fiscal_year = p_fiscal_year
    AND (NOT p_live_only OR is_test_mode = FALSE);
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

COMMENT ON FUNCTION user_yearly_reward_total IS
  '사용자의 해당 역년 누적 보상 합계. p_live_only=true 시 test mode 제외 (live 빌드 Cap 산정용). 기본 false (전체 합산, admin 검증용).';
