-- ── 030: voice_profiles 테이블 ──────────────────────────────────────────────
-- 목소리 등록 데이터 서버 저장 (기기 교체/앱 재설치 후 복원용)

CREATE TABLE IF NOT EXISTS voice_profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  enrollment_status   TEXT NOT NULL DEFAULT 'not_enrolled',
  embeddings          JSONB,           -- VoiceEmbedding[] (256-dim WeSpeaker vectors)
  reference_embedding JSONB,           -- number[] 256-dim L2-normalized average
  enrollment_count    INTEGER NOT NULL DEFAULT 0,
  min_enrollments     INTEGER NOT NULL DEFAULT 3,
  enrolled_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_profiles_user_id ON voice_profiles(user_id);
