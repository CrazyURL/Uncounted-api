-- PKCE 상태를 DB에 영속 저장 (서버 재시작 시 OAuth 플로우 유지)
CREATE TABLE pkce_store (
  flow_id TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  frontend_redirect TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes')
);

-- service_role만 접근 (RLS 정책 없이 활성화 = 모든 클라이언트 차단, service_role만 우회)
ALTER TABLE pkce_store ENABLE ROW LEVEL SECURITY;
