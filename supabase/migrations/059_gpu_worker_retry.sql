-- ════════════════════════════════════════════════════════════════════
-- Migration 059 — GPU 워커 재시도 + 에러 추적 컬럼
-- ════════════════════════════════════════════════════════════════════
--
-- WHY (BM v10 STAGE 2 — 운영 안정성)
--   STAGE 1 워커는 1 trace 만 작동. STAGE 2 에서 다음 추가:
--     - 일시적 실패 (네트워크 / voice_api 503 / GPU OOM) 자동 재시도
--     - 영구 실패 (포맷 불일치 / 손상 파일) 는 max 3회 후 포기
--     - 워커 사망 감지 (running 상태 10분 초과 → stuck → failed)
--     - 실패 사유 admin 가시화 (gpu_last_error)
--
-- 컬럼 의미
--   gpu_retry_count   재시도 횟수 (0 → 1 → 2 → 3, 3 도달 시 영구 failed)
--   gpu_last_error    마지막 실패 사유 (admin 검수 + 디버깅용)
--   gpu_started_at    'running' 상태 진입 시각 (stuck detection 기준)
--
-- 워커 폴링 쿼리 (STAGE 2 갱신):
--   픽업 대상:
--     status='pending' AND raw_audio_url IS NOT NULL  (신규)
--     OR
--     status='failed' AND retry_count < 3 AND updated_at < NOW()-INTERVAL '30 minutes'  (재시도)
--
--   stuck 감지 (별도 sweep):
--     status='running' AND gpu_started_at < NOW() - INTERVAL '10 minutes'
--     → 강제 failed 전환 후 재시도 큐 진입
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS gpu_retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gpu_last_error  TEXT,
  ADD COLUMN IF NOT EXISTS gpu_started_at  TIMESTAMPTZ;

COMMENT ON COLUMN sessions.gpu_retry_count IS
  'BM v10 — GPU 워커 재시도 횟수. 3 도달 시 영구 failed.';
COMMENT ON COLUMN sessions.gpu_last_error IS
  'BM v10 — 마지막 GPU 처리 실패 사유 (디버깅 + admin 표시).';
COMMENT ON COLUMN sessions.gpu_started_at IS
  'BM v10 — gpu_upload_status=running 진입 시각. 10분 초과 시 stuck 으로 간주.';

-- 재시도 큐 인덱스 — 30분 전 실패 + retry < 3
CREATE INDEX IF NOT EXISTS idx_sessions_gpu_retry_queue
  ON sessions(updated_at)
  WHERE gpu_upload_status = 'failed' AND gpu_retry_count < 3;

-- stuck 감지 인덱스
CREATE INDEX IF NOT EXISTS idx_sessions_gpu_stuck
  ON sessions(gpu_started_at)
  WHERE gpu_upload_status = 'running';
