-- 033: metadata_events RLS 비활성화
-- 024에서 만든 "me_service_only" 정책이 USING (false) / WITH CHECK (false)로
-- 모든 접근을 차단하여 /api/upload 경로에서 500(RLS violation) 발생.
-- service_role 전용 정책으로도 해결되지 않아 RLS를 비활성화.
-- 이 테이블은 supabaseAdmin(service_role)으로만 접근하므로 RLS 불필요.

DROP POLICY IF EXISTS "me_service_only" ON metadata_events;

ALTER TABLE metadata_events DISABLE ROW LEVEL SECURITY;
