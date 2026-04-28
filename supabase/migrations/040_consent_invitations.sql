-- 통화 상대방 동의 초대 영속화 (법무 가이드 Step 3 + Option A 게이트 C+)
-- 2026-04-29
--
-- 기존 consentInvitation.ts는 localStorage로만 초대 기록을 보관했으나,
-- 법무 컨설팅(2026-04-04)은 다음을 요구:
--   1. 초대 기록 영속화 (기기 초기화 시 손실 방지, 동의 사실 증빙)
--   2. 토큰 유효기간 무기한 권장 (expires_at NULL 허용)
--   3. 동의자 IP 주소 기록 (감사 추적)
--
-- localStorage는 클라이언트 캐시로만 활용하고, 본 테이블이 source of truth.

CREATE TABLE IF NOT EXISTS consent_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 누구의 어떤 세션에 대한 초대인지
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,

  -- 공유 토큰 (URL-safe, 16자 random)
  token TEXT UNIQUE NOT NULL,

  -- 상태: 'pending' | 'sent' | 'opened' | 'agreed' | 'declined' | 'expired'
  status TEXT NOT NULL DEFAULT 'pending',

  -- 시간 추적
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,  -- NULL = 무기한 (법무 권고 기본값)

  -- 동의자 정보 (감사 추적)
  ip_address INET,
  user_agent TEXT,

  -- 공유 방식: 'web_share' | 'clipboard' | NULL
  share_method TEXT,

  -- 멱등성 보장 (동일 사용자가 동일 세션에 활성 초대 1건만)
  CONSTRAINT unique_active_invitation_per_session
    UNIQUE NULLS NOT DISTINCT (user_id, session_id, status)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_consent_invitations_token
  ON consent_invitations(token);

CREATE INDEX IF NOT EXISTS idx_consent_invitations_user_session
  ON consent_invitations(user_id, session_id);

CREATE INDEX IF NOT EXISTS idx_consent_invitations_status
  ON consent_invitations(status);

CREATE INDEX IF NOT EXISTS idx_consent_invitations_created_at
  ON consent_invitations(created_at DESC);

-- RLS: service_role만 접근. 클라이언트는 API 경유.
-- 토큰 자체가 capability이므로, 토큰을 아는 사람만 조회 가능 (API에서 제어).
ALTER TABLE consent_invitations ENABLE ROW LEVEL SECURITY;
