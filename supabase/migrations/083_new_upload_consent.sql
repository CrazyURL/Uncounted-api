-- 083_new_upload_consent.sql
-- 사용자 레벨 "신규 통화 자동 업로드" 동의 — users_profile 확장 (schema only, additive).
--
-- 목적:
--   원칙은 both_agreed 세션만 원본(raw) 업로드. 그 위에 사용자가 "가입 이후 새로 녹음되는
--   통화도 자동으로 올릴지"를 선택할 수 있게 한다.
--     - new_upload_consent=true  → 가입 후 신규 통화(session.date > 가입일)도 자동 동의·업로드.
--     - new_upload_consent=false → 가입 시점에 폰에 있던 것(스냅샷)만 업로드. 신규는 미업로드.
--   디폴트는 회원가입 온보딩에서 사용자가 선택. (스냅샷/신규 경계 = session.date vs auth.users.created_at)
--
-- 본 마이그는 schema only (additive). 동의 적용·업로드 게이팅은 전부 애플리케이션(앱/폴러).
-- ⚠ 기존 테스트 사용자 backfill(=true)은 본 마이그에 포함하지 않는다 — 별도 backfill SQL + 승인 게이트.

ALTER TABLE users_profile
  ADD COLUMN IF NOT EXISTS new_upload_consent    BOOLEAN     DEFAULT false,
  ADD COLUMN IF NOT EXISTS new_upload_consent_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN users_profile.new_upload_consent IS
  '가입 후 신규 통화(session.date > 가입일) 자동 업로드 동의 여부. false=스냅샷(가입 시점 보유분만).';
COMMENT ON COLUMN users_profile.new_upload_consent_at IS
  '신규 업로드 동의 일시(감사용). NULL=미승인. 값 존재 시 신규 통화도 자동 업로드 대상.';
