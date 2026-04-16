-- 036: bu_quality_metrics RLS 비활성화
-- 022에서 만든 "bqm_service_only" 정책이 USING (false) / WITH CHECK (false)로
-- 모든 접근을 차단하여 packageBuilder의 품질 분석 단계에서
-- "new row violates row-level security policy" 500 에러 발생.
-- 033 (metadata_events_rls_fix)와 동일한 해결책 — 이 테이블은 supabaseAdmin
-- (service_role)으로만 접근하므로 RLS 불필요.

DROP POLICY IF EXISTS "bqm_service_only" ON bu_quality_metrics;

ALTER TABLE bu_quality_metrics DISABLE ROW LEVEL SECURITY;
