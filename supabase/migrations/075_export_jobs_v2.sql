-- Migration 075: export_jobs_v2 — Export v2 비동기 job (Phase 2B)
--
-- SPEC_EXPORT_V2.md §6.3. embedded WAV 단건 export 를 비동기 job 으로 처리.
-- 레거시 export_jobs (납품/billable_units 결합) 와 별개의 v2 전용 테이블.
--
-- 설계 결정 (Phase 2B):
--   - download_url 컬럼 없음. signed URL 은 GET /api/admin/export/jobs/:id 에서
--     storage_path 로 ready 시점에 동적 발급 (만료 짧음, 재발급 가능, DB 미저장).
--   - session_ids text[]: 단건은 길이 1. batch(Phase 3) 대비 배열.
--   - updated_at 은 앱 레이어에서 갱신 (074 와 동일 관행, 트리거 없음).
--   - RLS 미설정 (최근 마이그레이션 관행, service-role 접근).

CREATE TABLE IF NOT EXISTS export_jobs_v2 (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status              TEXT NOT NULL DEFAULT 'queued',
  session_ids         TEXT[] NOT NULL,
  audio_export_mode   TEXT NOT NULL,
  include_restricted  BOOLEAN NOT NULL DEFAULT false,
  packaging_stage     TEXT,
  storage_path        TEXT,
  size_bytes          BIGINT,
  download_expires_at TIMESTAMPTZ,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- status CHECK (재실행 시 중복 방지)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'export_jobs_v2'
      AND constraint_name = 'export_jobs_v2_status_check'
  ) THEN
    ALTER TABLE export_jobs_v2
      ADD CONSTRAINT export_jobs_v2_status_check
      CHECK (status IN ('queued', 'packaging', 'ready', 'failed'));
  END IF;
END $$;

-- audio_export_mode CHECK
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'export_jobs_v2'
      AND constraint_name = 'export_jobs_v2_audio_export_mode_check'
  ) THEN
    ALTER TABLE export_jobs_v2
      ADD CONSTRAINT export_jobs_v2_audio_export_mode_check
      CHECK (audio_export_mode IN ('reference_only', 'embedded'));
  END IF;
END $$;

-- 진행 중(queued/packaging) job 폴링/픽업용 부분 인덱스
CREATE INDEX IF NOT EXISTS idx_export_jobs_v2_active
  ON export_jobs_v2(status)
  WHERE status IN ('queued', 'packaging');

COMMENT ON TABLE  export_jobs_v2 IS 'Export v2 비동기 job (embedded WAV 단건). 레거시 export_jobs 와 별개.';
COMMENT ON COLUMN export_jobs_v2.storage_path IS 'ready 시 S3 객체 키. signed URL 은 GET 에서 동적 발급 (DB 미저장).';
COMMENT ON COLUMN export_jobs_v2.packaging_stage IS '워커 진행 단계 표시 (nullable).';

-- 검증:
--   \d+ export_jobs_v2
--   기대 컬럼 12개, download_url 컬럼 부재 확인.
