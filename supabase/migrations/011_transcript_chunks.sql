-- 011_transcript_chunks.sql
-- 청크별 트랜스크립트 + 오디오 품질 통계 저장 테이블
-- session_chunks(오디오 파일 저장) 와 분리 — 텍스트 + 품질 지표 전용.

CREATE TABLE IF NOT EXISTS transcript_chunks (
  id               BIGSERIAL        PRIMARY KEY,
  session_id       TEXT             NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id          TEXT             NOT NULL,
  chunk_index      INTEGER          NOT NULL,           -- 1-based (1, 2, 3, …)
  transcript_text  TEXT,                                -- PII-masked STT 결과
  start_sec        NUMERIC(10, 3)   NOT NULL,           -- 원본 파일 내 시작 시각(초)
  end_sec          NUMERIC(10, 3)   NOT NULL,           -- 원본 파일 내 종료 시각(초)
  duration_sec     NUMERIC(10, 3)   NOT NULL,           -- 청크 실제 재생 시간(초)
  audio_stats      JSONB,                               -- { rms, silenceRatio, clippingRatio, snrDb }
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),

  UNIQUE (session_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_transcript_chunks_session_id ON transcript_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_user_id    ON transcript_chunks(user_id);

-- RLS
ALTER TABLE transcript_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own transcript chunks"
  ON transcript_chunks
  FOR ALL
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Service role full access on transcript_chunks"
  ON transcript_chunks
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
