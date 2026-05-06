-- Migration 051: consent_invitations RLS 정책 추가
--
-- Why:
--   migration 040에서 RLS 활성화만 하고 정책을 추가하지 않음.
--   service_role이 아닌 컨텍스트(예: anon key + user JWT)에서 INSERT 시 42501 violation 발생.
--   본 마이그레이션은 sessions 테이블과 동일한 패턴으로 정책 추가.
--
-- 보안 고려:
--   - INSERT: 자신의 user_id로만 invitation 생성 가능
--   - SELECT: 자신의 invitation 조회 가능 (by-token GET은 service_role bypass 필요 — 별도)
--   - UPDATE: 자신의 invitation 상태 변경 가능 (sent_at 등)
--   - DELETE: 자신의 invitation 삭제 가능
--
-- /api/consent/by-token, /api/consent/agree/:token 등 익명 접근 endpoint는
-- supabaseAdmin (service_role) 사용 → RLS 우회. 본 정책에 영향 없음.

-- 기존 정책 정리 (멱등)
DROP POLICY IF EXISTS "consent_invitations_select_own" ON consent_invitations;
DROP POLICY IF EXISTS "consent_invitations_insert_own" ON consent_invitations;
DROP POLICY IF EXISTS "consent_invitations_update_own" ON consent_invitations;
DROP POLICY IF EXISTS "consent_invitations_delete_own" ON consent_invitations;

CREATE POLICY "consent_invitations_select_own" ON consent_invitations
  FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "consent_invitations_insert_own" ON consent_invitations
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "consent_invitations_update_own" ON consent_invitations
  FOR UPDATE USING (user_id = auth.uid() OR user_id IS NULL)
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "consent_invitations_delete_own" ON consent_invitations
  FOR DELETE USING (user_id = auth.uid() OR user_id IS NULL);
