-- Migration 050: consent_invitations.session_ids JSONB 컬럼 추가
--
-- Why:
--   - 한 invitation은 한 peer와의 N건 통화 전체를 대상으로 함 ("문식환님과의 344건의 통화")
--   - 기존 session_id 단일 컬럼만 있어 peer agree 시 1/N건만 promote 가능 (버그 D)
--   - session_ids JSONB 배열로 N건 전체 저장
--
-- 호환성:
--   - session_id (기존 컬럼) 유지 — 첫 번째 session_id를 fallback으로 박아둠
--   - 049 이전 invitation 데이터에는 session_ids = NULL (DB가 0건이라 고려 불요지만 안전 장치)
--   - /agree 핸들러는 session_ids가 NULL이면 session_id 단건으로 fallback

ALTER TABLE consent_invitations
  ADD COLUMN IF NOT EXISTS session_ids JSONB DEFAULT NULL;

COMMENT ON COLUMN consent_invitations.session_ids IS
  '한 peer 통화 그룹의 N건 sessions 배열. NULL이면 session_id 단건만 대상';

-- 조회 가속 — peer agree 시 sessions 일괄 update에 사용
CREATE INDEX IF NOT EXISTS idx_consent_invitations_session_ids
  ON consent_invitations USING gin (session_ids);
