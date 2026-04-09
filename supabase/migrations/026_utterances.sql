-- Migration 026: utterances 테이블 생성
-- 기획서 v3 섹션 3-3 스키마. 발화 단위 WAV + 메타데이터 저장.
-- PK 형식: 'utt_{sessionId}_{sequence:03d}'

CREATE TABLE IF NOT EXISTS utterances (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_id            BIGINT REFERENCES session_chunks(id),
  user_id             TEXT NOT NULL,

  -- 청크 내 순서 (1-based, 매핑용: "청크23의 발화14")
  sequence_in_chunk   INTEGER NOT NULL,
  -- 세션 전체 순서 (1-based, unique per session)
  sequence_order      INTEGER NOT NULL,

  -- 화자
  speaker_id          TEXT NOT NULL,
  is_user             BOOLEAN NOT NULL,

  -- 시간 (원본 오디오 기준, 절대 시간)
  start_sec           NUMERIC(10,3) NOT NULL,
  end_sec             NUMERIC(10,3) NOT NULL,
  duration_sec        NUMERIC(10,3) NOT NULL,

  -- 패딩 (절역 정밀도: 앞뒤 0.15초)
  padded_start_sec    NUMERIC(10,3),
  padded_end_sec      NUMERIC(10,3),
  padded_duration_sec NUMERIC(10,3),

  -- WAV 파일 (발화에만 물리 파일 존재)
  storage_path        TEXT,
  file_size_bytes     INTEGER,
  upload_status       TEXT DEFAULT 'pending',

  -- STT (word-level, 발화 구간 기준 상대 시간)
  transcript_text     TEXT,
  transcript_words    JSONB,

  -- 품질 (클라이언트 측정값)
  snr_db              NUMERIC,
  speech_ratio        NUMERIC,
  clipping_ratio      NUMERIC,
  beep_mask_ratio     NUMERIC,
  volume_lufs         NUMERIC,
  quality_score       NUMERIC,
  quality_grade       TEXT,

  -- 라벨 (발화 단위, A02/A03용)
  labels              JSONB,
  dialog_act          TEXT,
  dialog_intensity    INTEGER,
  label_source        TEXT,
  label_confidence    NUMERIC,

  -- PII
  pii_intervals       JSONB DEFAULT '[]',
  pii_reviewed_at     TIMESTAMPTZ,
  pii_reviewed_by     TEXT,

  -- 검수
  review_status       TEXT DEFAULT 'pending',
  exclude_reason      TEXT,

  -- v3: 출처 추적
  segmented_by        TEXT DEFAULT 'client',
  client_version      TEXT,

  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- 인덱스
CREATE INDEX idx_utt_session ON utterances(session_id);
CREATE INDEX idx_utt_chunk ON utterances(chunk_id);
CREATE INDEX idx_utt_chunk_seq ON utterances(chunk_id, sequence_in_chunk);
CREATE INDEX idx_utt_grade ON utterances(quality_grade);
CREATE INDEX idx_utt_review ON utterances(review_status);
CREATE INDEX idx_utt_speaker ON utterances(is_user);
CREATE UNIQUE INDEX idx_utt_session_order ON utterances(session_id, sequence_order);

-- RLS
ALTER TABLE utterances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_full_access_utterances" ON utterances
  FOR ALL USING (auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "users_read_own_utterances" ON utterances
  FOR SELECT USING (auth.uid()::text = user_id);

-- 또는 더 간단하게: service_role 전용 정책 추가
CREATE POLICY "service_role_bypass_utterances" ON utterances
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

