-- pkce_store 테이블에 대한 service_role 접근 정책 추가
-- RLS가 활성화되어 있으나 정책이 없어 service_role이 거부되는 경우 대응

CREATE POLICY "Enable all for service_role" ON public.pkce_store
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
