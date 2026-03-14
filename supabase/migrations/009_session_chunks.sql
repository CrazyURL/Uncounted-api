-- Migration 009: session_chunks (WAV 물리 청크 업로드 이력)
-- 대용량 WAV 파일을 30초 단위로 분할 업로드할 때 각 청크의 메타데이터 저장.
-- sessions 테이블의 자식 테이블 (1:N).

CREATE TABLE IF NOT EXISTS session_chunks (
  id               BIGSERIAL        PRIMARY KEY,
  session_id       TEXT             NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id          TEXT             NOT NULL,
  chunk_index      INTEGER          NOT NULL,           -- 1-based (1, 2, 3, …)
  storage_path     TEXT             NOT NULL,           -- sanitized-audio 버킷 내 경로
                                                        -- 형식: {userId}/{sessionId}/{sessionId}-001.wav
  start_sec        NUMERIC(10, 3)   NOT NULL,           -- 원본 파일 내 시작 시각(초)
  end_sec          NUMERIC(10, 3)   NOT NULL,           -- 원본 파일 내 종료 시각(초, stride 오버랩 포함)
  duration_sec     NUMERIC(10, 3)   NOT NULL,           -- 청크 WAV 실제 재생 시간(초)
  file_size_bytes  INTEGER,                             -- 업로드된 WAV 파일 크기(bytes)
  sample_rate      INTEGER          NOT NULL DEFAULT 16000,
  upload_status    TEXT             NOT NULL DEFAULT 'pending',
                                                        -- pending | uploaded | failed
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),

  UNIQUE (session_id, chunk_index)
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_session_chunks_session_id  ON session_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_session_chunks_user_id     ON session_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_session_chunks_status      ON session_chunks(upload_status);

-- RLS 활성화 (다른 테이블과 동일한 패턴)
ALTER TABLE session_chunks ENABLE ROW LEVEL SECURITY;

-- 사용자는 자신의 청크만 조회/수정 가능
CREATE POLICY "Users can manage own chunks"
  ON session_chunks
  FOR ALL
  USING (user_id = auth.uid()::text);

-- 서비스 롤은 모든 행 접근 가능 (백엔드 service_role key 사용)
CREATE POLICY "Service role full access"
  ON session_chunks
  FOR ALL
  TO service_role
  USING (true);
