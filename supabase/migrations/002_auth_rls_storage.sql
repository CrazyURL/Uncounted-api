-- ============================================================
-- Uncounted Migration v2 — Auth RLS + Storage + Auto-labeling
-- 2026-02-24
-- ============================================================
-- 실행 전: Supabase Dashboard에서 Auth > Email 활성화 필요
-- 실행 후: Storage > 버킷 2개 생성 필요 (sanitized-audio, meta-jsonl)
-- ============================================================

-- ── A. user_id 컬럼 추가 (nullable — 마이그레이션 기간 호환) ────────

ALTER TABLE users_profile
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE labels
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE consents
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE mission_progress
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── B. sessions 확장 (자동 라벨링 + 공개 준비) ──────────────────────

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS upload_status TEXT DEFAULT 'LOCAL';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pii_status TEXT DEFAULT 'CLEAR';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS share_scope TEXT DEFAULT 'PRIVATE';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS eligible_for_share BOOLEAN DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS review_action TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lock_reason JSONB;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lock_start_ms INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lock_end_ms INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS local_sanitized_wav_path TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS local_sanitized_text_preview TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS peer_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS label_status TEXT DEFAULT 'REVIEW';

-- visibility 컬럼 (globalConsent 시스템)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS visibility_status TEXT DEFAULT 'PRIVATE';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS visibility_source TEXT DEFAULT 'GLOBAL_DEFAULT';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS visibility_consent_version TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS visibility_changed_at TEXT;

-- de-dup 컬럼
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS dup_status TEXT DEFAULT 'none';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS dup_group_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS dup_confidence NUMERIC;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS file_hash_sha256 TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS audio_fingerprint TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS dup_representative BOOLEAN;

-- ── C. peers 테이블 (상대 엔티티) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS peers (
  id              TEXT PRIMARY KEY,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  pid             TEXT,
  display_name    TEXT NOT NULL,
  phone_hash      TEXT,
  masked_phone    TEXT,
  relationship    TEXT DEFAULT 'UNKNOWN',
  rel_confidence  NUMERIC(3,2) DEFAULT 0.00,
  rel_source      TEXT DEFAULT 'INFERRED',
  domain          TEXT DEFAULT 'ETC',
  dom_confidence  NUMERIC(3,2) DEFAULT 0.00,
  dom_source      TEXT DEFAULT 'INFERRED',
  call_count      INTEGER DEFAULT 0,
  total_duration  INTEGER DEFAULT 0,
  latest_date     TEXT,
  pii_flag        BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- sessions.peer_id FK (ALTER 후 테이블 존재 확인 뒤)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'sessions_peer_id_fkey'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_peer_id_fkey
      FOREIGN KEY (peer_id) REFERENCES peers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── D. session_labels 테이블 (자동 라벨 결과) ──────────────────────

CREATE TABLE IF NOT EXISTS session_labels (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  pid             TEXT,
  peer_id         TEXT REFERENCES peers(id) ON DELETE SET NULL,
  relationship    TEXT,
  domain          TEXT,
  label_status    TEXT NOT NULL DEFAULT 'REVIEW',
  rel_confidence  NUMERIC(3,2) DEFAULT 0.00,
  dom_confidence  NUMERIC(3,2) DEFAULT 0.00,
  rule_version    TEXT DEFAULT 'v1',
  pii_override    BOOLEAN DEFAULT false,
  applied_rules   JSONB,
  user_override   JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (session_id)
);

-- ── E. share_batches 테이블 ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS share_batches (
  id                TEXT PRIMARY KEY,
  user_id           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  pid               TEXT,
  target_scope      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'RUNNING',
  total_sessions    INTEGER DEFAULT 0,
  eligible_sessions INTEGER DEFAULT 0,
  locked_sessions   INTEGER DEFAULT 0,
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

-- ── F. 인덱스 ──────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_users_profile_user_id ON users_profile(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_peer_id ON sessions(peer_id);
CREATE INDEX IF NOT EXISTS idx_sessions_label_status ON sessions(label_status);
CREATE INDEX IF NOT EXISTS idx_sessions_upload_status ON sessions(upload_status);
CREATE INDEX IF NOT EXISTS idx_sessions_pii_status ON sessions(pii_status);
CREATE INDEX IF NOT EXISTS idx_labels_user_id ON labels(user_id);
CREATE INDEX IF NOT EXISTS idx_consents_user_id ON consents(user_id);
CREATE INDEX IF NOT EXISTS idx_mission_progress_user_id ON mission_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_peers_user_id ON peers(user_id);
CREATE INDEX IF NOT EXISTS idx_peers_pid ON peers(pid);
CREATE INDEX IF NOT EXISTS idx_peers_relationship ON peers(relationship);
CREATE INDEX IF NOT EXISTS idx_session_labels_session ON session_labels(session_id);
CREATE INDEX IF NOT EXISTS idx_session_labels_user_id ON session_labels(user_id);
CREATE INDEX IF NOT EXISTS idx_session_labels_status ON session_labels(label_status);
CREATE INDEX IF NOT EXISTS idx_session_labels_peer ON session_labels(peer_id);
CREATE INDEX IF NOT EXISTS idx_share_batches_user_id ON share_batches(user_id);

-- ── G. 기존 RLS 정책 제거 ──────────────────────────────────────────

DROP POLICY IF EXISTS "anon_all_sessions" ON sessions;
DROP POLICY IF EXISTS "anon_all_score_components" ON score_components;
DROP POLICY IF EXISTS "anon_all_labels" ON labels;
DROP POLICY IF EXISTS "anon_all_consents" ON consents;
DROP POLICY IF EXISTS "anon_all_matches" ON campaign_matches;
DROP POLICY IF EXISTS "anon_all_mission_progress" ON mission_progress;

-- ── H. RLS 정책 — users_profile ────────────────────────────────────

ALTER TABLE users_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_profile_select_own" ON users_profile
  FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "users_profile_insert_own" ON users_profile
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "users_profile_update_own" ON users_profile
  FOR UPDATE USING (user_id = auth.uid() OR user_id IS NULL)
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "users_profile_delete_own" ON users_profile
  FOR DELETE USING (user_id = auth.uid() OR user_id IS NULL);

-- ── H. RLS 정책 — sessions ─────────────────────────────────────────

CREATE POLICY "sessions_select_own" ON sessions
  FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "sessions_insert_own" ON sessions
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "sessions_update_own" ON sessions
  FOR UPDATE USING (user_id = auth.uid() OR user_id IS NULL)
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "sessions_delete_own" ON sessions
  FOR DELETE USING (user_id = auth.uid() OR user_id IS NULL);

-- ── H. RLS 정책 — score_components (JOIN 기반) ─────────────────────

CREATE POLICY "score_components_select_own" ON score_components
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = score_components.session_id
      AND (s.user_id = auth.uid() OR s.user_id IS NULL)
    )
  );

CREATE POLICY "score_components_insert_own" ON score_components
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = score_components.session_id
      AND (s.user_id = auth.uid() OR s.user_id IS NULL)
    )
  );

CREATE POLICY "score_components_update_own" ON score_components
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = score_components.session_id
      AND (s.user_id = auth.uid() OR s.user_id IS NULL)
    )
  );

-- ── H. RLS 정책 — labels ───────────────────────────────────────────

CREATE POLICY "labels_select_own" ON labels
  FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "labels_insert_own" ON labels
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "labels_update_own" ON labels
  FOR UPDATE USING (user_id = auth.uid() OR user_id IS NULL)
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

-- ── H. RLS 정책 — campaigns (읽기 전용) ────────────────────────────

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "campaigns_select_authenticated" ON campaigns
  FOR SELECT USING (auth.role() = 'authenticated');

-- ── H. RLS 정책 — missions (읽기 전용) ─────────────────────────────

ALTER TABLE missions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "missions_select_authenticated" ON missions
  FOR SELECT USING (auth.role() = 'authenticated');

-- ── H. RLS 정책 — campaign_matches (JOIN 기반 읽기 전용) ────────────

CREATE POLICY "campaign_matches_select_own" ON campaign_matches
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = campaign_matches.session_id
      AND (s.user_id = auth.uid() OR s.user_id IS NULL)
    )
  );

-- ── H. RLS 정책 — consents ─────────────────────────────────────────

CREATE POLICY "consents_select_own" ON consents
  FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "consents_insert_own" ON consents
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "consents_update_own" ON consents
  FOR UPDATE USING (user_id = auth.uid() OR user_id IS NULL)
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

-- ── H. RLS 정책 — mission_progress ─────────────────────────────────

CREATE POLICY "mission_progress_select_own" ON mission_progress
  FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "mission_progress_insert_own" ON mission_progress
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "mission_progress_update_own" ON mission_progress
  FOR UPDATE USING (user_id = auth.uid() OR user_id IS NULL)
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

-- ── H. RLS 정책 — peers ────────────────────────────────────────────

ALTER TABLE peers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "peers_select_own" ON peers
  FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "peers_insert_own" ON peers
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "peers_update_own" ON peers
  FOR UPDATE USING (user_id = auth.uid() OR user_id IS NULL)
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "peers_delete_own" ON peers
  FOR DELETE USING (user_id = auth.uid() OR user_id IS NULL);

-- ── H. RLS 정책 — session_labels ───────────────────────────────────

ALTER TABLE session_labels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "session_labels_select_own" ON session_labels
  FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "session_labels_insert_own" ON session_labels
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "session_labels_update_own" ON session_labels
  FOR UPDATE USING (user_id = auth.uid() OR user_id IS NULL)
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

-- ── H. RLS 정책 — share_batches ────────────────────────────────────

ALTER TABLE share_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "share_batches_select_own" ON share_batches
  FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "share_batches_insert_own" ON share_batches
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "share_batches_update_own" ON share_batches
  FOR UPDATE USING (user_id = auth.uid() OR user_id IS NULL)
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

-- ── I. Storage 버킷 생성 (Dashboard에서 수동 또는 아래 SQL) ─────────
-- 주의: storage.buckets INSERT는 service_role 또는 Dashboard에서만 가능
-- 아래는 참고용 — Supabase Dashboard > Storage에서 생성 권장

-- INSERT INTO storage.buckets (id, name, public, file_size_limit)
-- VALUES
--   ('sanitized-audio', 'sanitized-audio', false, 52428800),
--   ('meta-jsonl', 'meta-jsonl', false, 10485760)
-- ON CONFLICT (id) DO NOTHING;

-- ── J. Storage 접근 정책 ────────────────────────────────────────────
-- 경로 규칙: {bucket}/{user_id}/{filename}
-- (storage.foldername(name))[1] = 첫 번째 폴더 = user_id

-- sanitized-audio 버킷

CREATE POLICY "audio_select_own" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'sanitized-audio'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "audio_insert_own" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'sanitized-audio'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "audio_update_own" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'sanitized-audio'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "audio_delete_own" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'sanitized-audio'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- meta-jsonl 버킷

CREATE POLICY "meta_select_own" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'meta-jsonl'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "meta_insert_own" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'meta-jsonl'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "meta_delete_own" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'meta-jsonl'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── K. pid → user_id 마이그레이션 RPC (선택) ──────────────────────
-- 첫 로그인 시 프론트에서 호출하여 기존 pid 데이터를 user_id와 연결

CREATE OR REPLACE FUNCTION link_pid_to_user(p_pid TEXT, p_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE users_profile SET user_id = p_user_id WHERE pid = p_pid AND user_id IS NULL;
  UPDATE sessions SET user_id = p_user_id WHERE pid = p_pid AND user_id IS NULL;
  UPDATE labels SET user_id = p_user_id
    WHERE session_id IN (SELECT id FROM sessions WHERE pid = p_pid)
    AND user_id IS NULL;
  UPDATE consents SET user_id = p_user_id WHERE pid = p_pid AND user_id IS NULL;
  UPDATE mission_progress SET user_id = p_user_id WHERE pid = p_pid AND user_id IS NULL;
  UPDATE peers SET user_id = p_user_id WHERE pid = p_pid AND user_id IS NULL;
  UPDATE session_labels SET user_id = p_user_id WHERE pid = p_pid AND user_id IS NULL;
  UPDATE share_batches SET user_id = p_user_id WHERE pid = p_pid AND user_id IS NULL;
END;
$$;
