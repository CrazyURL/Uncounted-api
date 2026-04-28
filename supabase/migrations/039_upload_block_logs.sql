-- 동의 게이팅 컴플라이언스: 업로드 차단 로그
-- v3.0 BM 게이트 C 작업 (2026-04-29)
--
-- uploadSanitizedAudio() 가드가 동의 미충족(consentStatus='locked' 등)으로 인해
-- WAV 업로드를 차단했을 때 운영 추적용으로 기록한다.
-- 컴플라이언스 감사 + 사용자 동의 흐름 디버깅에 사용.

CREATE TABLE IF NOT EXISTS upload_block_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT,
  consent_status TEXT,           -- 'locked' | 'user_only' | 'both_agreed' | NULL
  visibility_status TEXT,        -- 'PRIVATE' | 'PUBLIC_CONSENTED' | NULL
  block_reason TEXT NOT NULL,    -- 'consent_locked' | 'visibility_private' | 'diarization_pending'
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT NULL    -- 추가 컨텍스트 (sessionTitle, blob size 등)
);

CREATE INDEX IF NOT EXISTS idx_upload_block_user_session
  ON upload_block_logs(user_id, session_id);

CREATE INDEX IF NOT EXISTS idx_upload_block_attempted_at
  ON upload_block_logs(attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_upload_block_reason
  ON upload_block_logs(block_reason);

-- service_role만 접근 (RLS 활성화, 정책 없음 = 모든 anon/authenticated 차단)
ALTER TABLE upload_block_logs ENABLE ROW LEVEL SECURITY;
