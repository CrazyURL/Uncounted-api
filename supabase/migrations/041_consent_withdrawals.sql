-- 동의 철회 감사 로그 (Option A 게이트 C+, 2026-04-29)
--
-- PIPA 제36조에 따른 동의 철회 시 회사가 이행한 4단계 처리를 감사 추적.
-- 처리 5일 이내 요건(PIPA 시행령 43조) 준수 증빙.
--
-- 4단계 처리:
--   1. cancelled_pending_count: 납품 대기 항목 취소 수
--   2. deleted_storage_files: 삭제된 S3 파일 수
--   3. anonymized_at: 개인정보 익명화 시각
--   4. delivered_sessions: 이미 제3자에게 제공된 세션·구매자 목록 (사용자 안내용)

CREATE TABLE IF NOT EXISTS consent_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 4단계 처리 결과
  withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_pending_count INT DEFAULT 0,
  deleted_storage_files INT DEFAULT 0,
  anonymized_at TIMESTAMPTZ,

  -- 이미 제공된 세션 목록 (구매자 안내용 — JSONB)
  -- 형식: [{ "sessionId": "...", "clientId": "...", "deliveredAt": "ISO" }, ...]
  delivered_sessions JSONB DEFAULT '[]'::jsonb,

  -- 사용자 사유 (선택)
  reason TEXT,

  -- 처리 완료 시각 (5일 SLA 추적)
  completed_at TIMESTAMPTZ,

  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_consent_withdrawals_user
  ON consent_withdrawals(user_id);

CREATE INDEX IF NOT EXISTS idx_consent_withdrawals_withdrawn_at
  ON consent_withdrawals(withdrawn_at DESC);

ALTER TABLE consent_withdrawals ENABLE ROW LEVEL SECURITY;
