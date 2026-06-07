-- PR: PIPC 2026 가이드 §13(학습 거부권) + §14(자동화된 결정 거부) + §18(변경 이력) 정합
-- Window: PIPC 2026 v1.3 정합 트랙
-- Date: 2026-06-05
-- Note: 우리 schema 에 자체 users 테이블 없음 — Supabase 내장 auth.users 만 사용.
--       학습 거부 플래그는 별도 user_learning_optout 테이블에 보관.
--       sessions.id / utterances.id 는 TEXT (UUID 아님).

-- ============================================================
-- 1. AI 학습 거부 (Opt-out) — 별도 테이블 (auth.users 참조)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_learning_optout (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  learning_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  learning_opt_out_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE user_learning_optout IS
  '처리방침 v1.3 §13.1 AI 학습 데이터 활용 거부 (Opt-out). '
  'row 부재 = default false (활용 허용). row 존재 + true = 거부.';

CREATE INDEX IF NOT EXISTS idx_user_learning_optout_true
  ON user_learning_optout(user_id)
  WHERE learning_opt_out = TRUE;

-- ============================================================
-- 2. 자동화된 결정 거부·설명 요구 테이블
-- ============================================================
CREATE TABLE IF NOT EXISTS automated_decision_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  appeal_type TEXT NOT NULL CHECK (appeal_type IN ('reject', 'explain')),
  decision_area TEXT NOT NULL CHECK (decision_area IN (
    'pii_masking',
    'speaker_diarization',
    'quality_grade',
    'dataset_eligibility'
  )),
  user_message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'in_review', 'resolved', 'rejected'
  )),
  admin_response TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE automated_decision_appeals IS
  '처리방침 v1.3 §14.5 자동화된 결정 거부·설명 요구 큐. '
  '사용자 제출 → admin 검토 (10영업일 회신 의무).';

CREATE INDEX IF NOT EXISTS idx_appeals_user
  ON automated_decision_appeals(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_appeals_status
  ON automated_decision_appeals(status, created_at DESC)
  WHERE status IN ('pending', 'in_review');

-- ============================================================
-- 3. 처리 결과 신고 테이블 — §13.3
-- ============================================================
CREATE TABLE IF NOT EXISTS processing_result_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  utterance_id TEXT REFERENCES utterances(id) ON DELETE SET NULL,
  report_type TEXT NOT NULL CHECK (report_type IN (
    'pii_not_masked', 'wrong_speaker', 'wrong_text', 'other'
  )),
  user_message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'in_review', 'resolved', 'rejected'
  )),
  admin_response TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE processing_result_reports IS
  '처리방침 v1.3 §13.3 처리 결과 신고. 3영업일 검토 의무.';

CREATE INDEX IF NOT EXISTS idx_reports_user
  ON processing_result_reports(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reports_status
  ON processing_result_reports(status, created_at DESC)
  WHERE status IN ('pending', 'in_review');

-- ============================================================
-- 4. 처리방침 변경 이력 + 사용자별 동의 이력
-- ============================================================
CREATE TABLE IF NOT EXISTS privacy_policy_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL UNIQUE,
  effective_date DATE,
  summary TEXT NOT NULL,
  full_text_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_privacy_policy_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  policy_version TEXT NOT NULL REFERENCES privacy_policy_versions(version),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, policy_version)
);

COMMENT ON TABLE privacy_policy_versions IS
  '처리방침 v1.3 §18.4 개정 이력. 신·구 비교 페이지 데이터 소스.';
COMMENT ON TABLE user_privacy_policy_acceptances IS
  '사용자별 처리방침 버전 동의 이력. 30일 전 공지 후 동의 안 한 사용자 식별용.';

INSERT INTO privacy_policy_versions (version, effective_date, summary) VALUES
  ('v1.0', '2026-04-29', '최초 작성'),
  ('v1.1', '2026-05-04', '프로필 억양 항목 추가'),
  ('v1.2', '2026-05-10', 'BM v10 — raw 음성 서버 30일 보관 명시 + 처리 흐름 도식'),
  ('v1.3', NULL, 'PIPC 2026 가이드 정합 — 자동화된 결정(§14) / 가명정보(§11) / 추가적 이용·제공 판단기준(§12) / 학습 거부권(§13) 신설. effective_date 는 시행일 결정 후 update.')
ON CONFLICT (version) DO NOTHING;
