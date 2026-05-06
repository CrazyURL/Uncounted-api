-- Migration 052: sessions 처리 흐름 + 검수 상태 컬럼 추가
--
-- Why:
--   BM v10 admin 개편에 따라 운영자가 파일별 GPU 처리 단계와 검수 단계를
--   한 화면에서 추적해야 함.
--
-- ⚠️ BM v9 컬럼 충돌 해결 (2026-05-06):
--   기존 sessions 에 BM v9 컬럼이 다른 의미로 존재 → gpu_* 접두어로 분리:
--     - 기존 upload_status (LOCAL/QUEUED/UPLOADING/UPLOADED/FAILED) — 클라이언트 ↔ 백엔드 업로드 상태머신
--     - 기존 pii_status (CLEAR/SUSPECT/LOCKED/REVIEWED) — PII 검토 상태머신
--   본 마이그레이션은 GPU 단계 추적용 컬럼을 신규 추가:
--     - gpu_upload_status (백엔드 → GPU 서버 업로드)
--     - gpu_pii_status (GPU PII 자동 마스킹)
--
-- 컬럼 분리 이유:
--   - gpu_upload / stt / diarize / gpu_pii / quality_status: GPU 자동 처리 단계
--   - review_status: 운영자 수동 검수 (별도 상태머신)
--
-- status 값 (gpu_upload/stt/diarize/gpu_pii/quality):
--   pending  — 시작 전
--   running  — GPU 서버 처리 중
--   done     — 완료
--   failed   — 실패 (재시도 대상)
--
-- review_status 값 (운영자 검수 5단계):
--   pending         — 처리 흐름 미완. 검수 대기 X
--   in_review       — 운영자 검수 중 (샘플링 진행)
--   approved        — 검수 통과. 납품 가능
--   rejected        — 운영자 거절 (저품질·약관 위반)
--   needs_revision  — 수정 필요 (PII 보정·라벨 수정)

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS gpu_upload_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS gpu_uploaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stt_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS stt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS diarize_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS diarize_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gpu_pii_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS gpu_pii_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quality_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS quality_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'pending';

-- CHECK 제약 (잘못된 값 입력 차단)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_gpu_upload_status_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_gpu_upload_status_check
      CHECK (gpu_upload_status IN ('pending', 'running', 'done', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_stt_status_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_stt_status_check
      CHECK (stt_status IN ('pending', 'running', 'done', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_diarize_status_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_diarize_status_check
      CHECK (diarize_status IN ('pending', 'running', 'done', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_gpu_pii_status_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_gpu_pii_status_check
      CHECK (gpu_pii_status IN ('pending', 'running', 'done', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_quality_status_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_quality_status_check
      CHECK (quality_status IN ('pending', 'running', 'done', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_review_status_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_review_status_check
      CHECK (review_status IN ('pending', 'in_review', 'approved', 'rejected', 'needs_revision'));
  END IF;
END $$;

-- 검수 대기열 / 단계별 분포 조회를 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_sessions_review_status ON sessions(review_status);
CREATE INDEX IF NOT EXISTS idx_sessions_pipeline_v2 ON sessions(stt_status, diarize_status, gpu_pii_status, quality_status);
CREATE INDEX IF NOT EXISTS idx_sessions_gpu_upload ON sessions(gpu_upload_status);

COMMENT ON COLUMN sessions.gpu_upload_status IS '백엔드 → GPU 서버 업로드 상태 (pending/running/done/failed). BM v9 의 upload_status (LOCAL/UPLOADED) 와 별개.';
COMMENT ON COLUMN sessions.stt_status IS 'GPU STT 단계 상태';
COMMENT ON COLUMN sessions.diarize_status IS 'GPU 화자 분리 단계 상태';
COMMENT ON COLUMN sessions.gpu_pii_status IS 'GPU PII 마스킹 단계 상태. BM v9 의 pii_status (CLEAR/SUSPECT/LOCKED/REVIEWED) 와 별개.';
COMMENT ON COLUMN sessions.quality_status IS 'GPU 품질 자동 검증 단계 상태';
COMMENT ON COLUMN sessions.review_status IS '운영자 수동 검수 5단계 상태머신';
