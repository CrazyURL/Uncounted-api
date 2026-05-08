-- Migration 056: deliveries RLS 정책 단순화 (auth.users 참조 제거)
--
-- Why:
--   054 의 RLS 정책이 sub-select 안에서 auth.users 를 SELECT 하는 형태였음:
--     EXISTS (SELECT 1 FROM auth.users u WHERE u.id = auth.uid()
--             AND (u.raw_app_meta_data ->> 'role') = 'admin')
--   이 정책은 PostgREST 의 authenticated role 평가 시 auth.users 의 SELECT
--   권한을 요구 → "permission denied for table users" 에러 발생.
--   /admin/transactions 페이지에서 GET /api/admin/deliveries 호출 시 차단됨.
--
-- 해결:
--   JWT 의 app_metadata.role 을 직접 검사 (auth.users 테이블 미접근).
--   service_role 은 RLS bypass 이므로 정책 자체와 무관.
--
-- 같은 패턴을 사용하는 다른 신규 테이블이 있으면 동일하게 단순화 권장.

DROP POLICY IF EXISTS "deliveries_admin_all" ON deliveries;
DROP POLICY IF EXISTS "deliveries_service_role" ON deliveries;

-- 운영자 (JWT app_metadata.role = 'admin') 만 ALL
CREATE POLICY "deliveries_admin_all" ON deliveries
  FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

COMMENT ON POLICY "deliveries_admin_all" ON deliveries IS
  '운영자(JWT app_metadata.role=admin)만 ALL. auth.users 테이블 미참조 — PostgREST permission 에러 회피.';
