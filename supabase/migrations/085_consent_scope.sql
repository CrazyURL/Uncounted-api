-- 085_consent_scope.sql
-- 상대방(counterparty) 동의 범위 — peer.html 에서 받는 분이 직접 고른 scope.
--
-- 배경 (양측동의 = 두 명의 동의):
--   업로드는 ① 앱 소유자(녹음자) 동의 + ② 상대방 동의가 모두 있어야 한다(both_agreed).
--   ②의 "어디까지 동의하는지"를 받는 분이 peer.html 에서 직접 고른다:
--     - 'ongoing'  : 지금까지 + 앞으로의 통화 모두 (기존 "과거+앞으로" 의미 = 기본값)
--     - 'snapshot' : 지금까지의 통화만 (앞으로의 통화는 미포함)
--   POST /api/consent/agree/:token body.scope → promoteToBothAgreed 가 본 컬럼에 기록.
--
-- 기존 status='agreed' 행은 default 'ongoing' (예전 페이지가 "과거+앞으로 모두 적용" 문구 →
--   의미 보존 = backfill 안전). additive · schema only. 되돌리기 = 컬럼 무시.

ALTER TABLE consent_invitations
  ADD COLUMN IF NOT EXISTS consent_scope TEXT DEFAULT 'ongoing';

COMMENT ON COLUMN consent_invitations.consent_scope IS
  '상대방이 고른 동의 범위: ongoing=지금까지+앞으로 모두 / snapshot=지금까지의 통화만. 기본 ongoing.';
