-- ============================================================
-- Uncounted MVP Schema v1
-- 2026-02-23
-- ============================================================

-- ── 1. users_profile ─────────────────────────────────────────
-- 비PII 메타데이터 (localStorage pid를 기반으로 연결)
CREATE TABLE IF NOT EXISTS users_profile (
  pid             TEXT PRIMARY KEY,          -- 익명 UUID (기기 생성)
  age_band        TEXT,                      -- '10대'|'20대'|...|'응답안함'
  gender          TEXT,                      -- '남성'|'여성'|'논바이너리'|'응답안함'
  region_group    TEXT,                      -- '수도권'|'영남'|...|'응답안함'
  accent_group    TEXT,                      -- '표준'|'경상도'|...|'모르겠음'
  speech_style    TEXT,                      -- '주로 존댓말'|...|'응답안함'
  primary_language TEXT,                     -- 'ko-KR'|'en-US'|...|'응답안함'
  common_env      TEXT,                      -- '조용한 실내'|'보통'|'시끄러운 환경'|'응답안함'
  common_device_mode TEXT,                   -- '수화기'|'핸즈프리'|'블루투스'|'혼합'|'응답안함'
  domain_mix      TEXT[],                    -- 최대 3개 선택
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. sessions ───────────────────────────────────────────────
-- 음성 세션 (스캔된 통화 녹음 기반)
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  pid               TEXT REFERENCES users_profile(pid) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  date              TEXT NOT NULL,           -- YYYY-MM-DD
  duration          INTEGER NOT NULL,        -- 초 단위
  qa_score          INTEGER NOT NULL DEFAULT 0,
  contribution_score INTEGER NOT NULL DEFAULT 0,
  labels            JSONB,                   -- LabelCategory | null
  strategy_locked   BOOLEAN NOT NULL DEFAULT false,
  asset_type        TEXT NOT NULL,           -- '업무/회의'|'기술 논의'|'교육/강의'|'비즈니스'
  is_public         BOOLEAN NOT NULL DEFAULT false,
  status            TEXT NOT NULL DEFAULT 'uploaded',
  is_pii_cleaned    BOOLEAN NOT NULL DEFAULT false,
  chunk_count       INTEGER NOT NULL DEFAULT 0,
  audio_url         TEXT,                    -- Supabase Storage URL (비식별화 완료본)
  call_record_id    TEXT,                    -- 원본 파일 경로 (기기 내부, 서버 미저장)
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. score_components ───────────────────────────────────────
-- 세션별 점수 계수 (v1 알고리즘 스냅샷)
CREATE TABLE IF NOT EXISTS score_components (
  id               BIGSERIAL PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  algo_version     TEXT NOT NULL DEFAULT 'v1',
  base_units       NUMERIC(8,2),            -- 유효발화 분 (E_i)
  length_factor    NUMERIC(5,2),
  quality_factor   NUMERIC(5,2),
  domain_factor    NUMERIC(5,2),
  rarity_factor    NUMERIC(5,2),
  label_factor     NUMERIC(5,2),
  composite        NUMERIC(8,3),
  earning_low      INTEGER,                 -- ₩320/분 시나리오
  earning_mid      INTEGER,                 -- ₩437/분 시나리오
  earning_high     INTEGER,                 -- ₩620/분 시나리오
  calculated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 4. labels ─────────────────────────────────────────────────
-- 세션 라벨 이력 (변경 감사 용도)
CREATE TABLE IF NOT EXISTS labels (
  id           BIGSERIAL PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  relationship TEXT,
  purpose      TEXT,
  domain       TEXT,
  tone         TEXT,
  noise        TEXT,
  labeled_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── 5. campaigns ──────────────────────────────────────────────
-- 캠페인 마스터 (앱 상수와 동기화, 향후 서버 관리용)
CREATE TABLE IF NOT EXISTS campaigns (
  id              TEXT PRIMARY KEY,          -- 'BIZ'|'SALES'|'MIX'
  name            TEXT NOT NULL,
  description     TEXT,
  unit_price      INTEGER NOT NULL,          -- ₩/분
  bonus_label     TEXT,
  required_tier   TEXT,                      -- null = 누구나
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO campaigns (id, name, description, unit_price, bonus_label) VALUES
  ('BIZ',   '비즈니스 HQ',   '10분 이상의 업무·회의 고품질 녹음', 580, '+15% 도메인 보너스'),
  ('SALES', '영업/상담 감정', '2~10분 상담 통화에 감정 라벨',       520, '+20% 감정 라벨 보너스'),
  ('MIX',   '다국어 믹스',   '다국어 환경 녹음 — 짧은 파일도 환영', 480, '+10% 다국어 보너스')
ON CONFLICT (id) DO NOTHING;

-- ── 6. campaign_matches ───────────────────────────────────────
-- 세션 × 캠페인 매칭 결과
CREATE TABLE IF NOT EXISTS campaign_matches (
  id           BIGSERIAL PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  matched_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (campaign_id, session_id)
);

-- ── 7. consents ───────────────────────────────────────────────
-- 사용자 데이터 공개 동의 이력 (개인정보보호법 준거)
CREATE TABLE IF NOT EXISTS consents (
  id           BIGSERIAL PRIMARY KEY,
  pid          TEXT NOT NULL,               -- 익명 사용자 ID
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  action       TEXT NOT NULL CHECK (action IN ('join', 'withdraw')),
  consented_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 8. missions ───────────────────────────────────────────────
-- 미션 마스터
CREATE TABLE IF NOT EXISTS missions (
  code         TEXT PRIMARY KEY,            -- 'LABEL_10'|'HQ_30MIN'|'CAMPAIGN_JOIN'
  title        TEXT NOT NULL,
  description  TEXT,
  reward       TEXT,
  target_value INTEGER NOT NULL
);

INSERT INTO missions (code, title, description, reward, target_value) VALUES
  ('LABEL_10',      '라벨 10개 완료',    '세션 라벨을 10개 이상 완성',             'CP +200 · Silver 배지', 10),
  ('HQ_30MIN',      '고품질 녹음 30분',  'QA 80점 이상 세션 합산 30분 이상',       'CP +300 · Gold 배지',   30),
  ('CAMPAIGN_JOIN', '캠페인 3개 참여',   '3개 이상의 캠페인에 데이터 공개 동의',   'CP +500 · Platinum 배지', 3)
ON CONFLICT (code) DO NOTHING;

-- ── 9. mission_progress ───────────────────────────────────────
-- 미션 달성 이력 (중복 수령 방지)
CREATE TABLE IF NOT EXISTS mission_progress (
  id           BIGSERIAL PRIMARY KEY,
  pid          TEXT NOT NULL,
  mission_code TEXT NOT NULL REFERENCES missions(code) ON DELETE CASCADE,
  current_val  INTEGER NOT NULL DEFAULT 0,
  completed    BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (pid, mission_code)
);

-- ── 인덱스 ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sessions_pid ON sessions(pid);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_is_public ON sessions(is_public);
CREATE INDEX IF NOT EXISTS idx_score_components_session ON score_components(session_id);
CREATE INDEX IF NOT EXISTS idx_labels_session ON labels(session_id);
CREATE INDEX IF NOT EXISTS idx_campaign_matches_campaign ON campaign_matches(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_matches_session ON campaign_matches(session_id);
CREATE INDEX IF NOT EXISTS idx_consents_pid ON consents(pid);
CREATE INDEX IF NOT EXISTS idx_consents_campaign ON consents(campaign_id);
CREATE INDEX IF NOT EXISTS idx_mission_progress_pid ON mission_progress(pid);

-- ── RLS (Row Level Security) ──────────────────────────────────
-- MVP: anon key로 전체 읽기·쓰기 허용 (추후 JWT 기반 pid 검증으로 교체)
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_sessions" ON sessions FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE score_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_score_components" ON score_components FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_labels" ON labels FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_consents" ON consents FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE campaign_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_matches" ON campaign_matches FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE mission_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_mission_progress" ON mission_progress FOR ALL USING (true) WITH CHECK (true);
