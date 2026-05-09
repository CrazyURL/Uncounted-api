-- ════════════════════════════════════════════════════════════════════
-- Migration 058 — Raw audio 업로드 파이프라인 컬럼
-- ════════════════════════════════════════════════════════════════════
--
-- WHY
--   BM v10 — App 이 raw audio 를 iwinv S3 (dev.storage.uncounted.cloud)
--   에 업로드. GPU 워커가 그 파일을 가져와 voice_api 로 전달.
--   업로드된 raw audio 의 S3 storage path 를 sessions 에 보관.
--
--   기존 audio_url 컬럼은 휴대폰 로컬 경로 (BM v9 잔존) 라 의미 충돌.
--   raw_audio_url 신규 컬럼으로 명확히 분리.
--
-- 컬럼 의미
--   raw_audio_url      iwinv S3 prefix path (예: 'raw-audio/{userId}/{sessionId}.m4a')
--                      NULL = 미업로드. NOT NULL = 업로드 완료, GPU 큐 대기 중.
--   raw_audio_size     업로드 파일 크기 (bytes) — 큐/모니터링용
--   raw_audio_uploaded_at  업로드 시각 — 30일 lifecycle 정책 기준
--
-- 워커 폴링 쿼리는 이렇게:
--   SELECT * FROM sessions
--   WHERE raw_audio_url IS NOT NULL
--     AND gpu_upload_status = 'pending'
--   ORDER BY raw_audio_uploaded_at ASC
--   LIMIT 1 FOR UPDATE SKIP LOCKED;
--
-- 30일 lifecycle (별도 cron/policy):
--   raw_audio_uploaded_at < NOW() - INTERVAL '30 days'  →  S3 객체 삭제
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS raw_audio_url       TEXT,
  ADD COLUMN IF NOT EXISTS raw_audio_size      BIGINT,
  ADD COLUMN IF NOT EXISTS raw_audio_uploaded_at TIMESTAMPTZ;

COMMENT ON COLUMN sessions.raw_audio_url IS
  'BM v10 — iwinv S3 raw audio storage path (prefix: raw-audio/{userId}/{sessionId}.{ext}). NULL=미업로드.';
COMMENT ON COLUMN sessions.raw_audio_size IS
  'BM v10 — raw audio 파일 크기 (bytes).';
COMMENT ON COLUMN sessions.raw_audio_uploaded_at IS
  'BM v10 — raw audio S3 업로드 시각. 30일 lifecycle 기준.';

-- 워커 폴링 인덱스 — gpu_upload_status='pending' AND raw_audio_url IS NOT NULL
-- 양쪽 조건 자주 OR 단독 사용. 부분 인덱스로 작은 사이즈 유지.
CREATE INDEX IF NOT EXISTS idx_sessions_raw_audio_pending
  ON sessions(raw_audio_uploaded_at)
  WHERE raw_audio_url IS NOT NULL AND gpu_upload_status = 'pending';

-- 30일 lifecycle 만료 대상 인덱스
CREATE INDEX IF NOT EXISTS idx_sessions_raw_audio_expiry
  ON sessions(raw_audio_uploaded_at)
  WHERE raw_audio_url IS NOT NULL;
