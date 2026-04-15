-- 036_pii_masking_audit.sql
-- PII 마스킹 적용 이력을 감사할 수 있도록 utterances 테이블에 메타 컬럼 추가.
-- pii_intervals/pii_reviewed_*는 "구간 그렸음/저장됨" 단계,
-- pii_masked_*는 "apply-mask로 WAV가 실제 변경됨" 단계.

ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS pii_masked          BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pii_masked_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pii_masked_by       TEXT,
  ADD COLUMN IF NOT EXISTS pii_masked_by_email TEXT,
  ADD COLUMN IF NOT EXISTS pii_mask_version    INTEGER     NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_utt_pii_masked
  ON utterances(pii_masked) WHERE pii_masked = true;

COMMENT ON COLUMN utterances.pii_masked IS 'apply-mask로 WAV 변경이 완료된 상태';
COMMENT ON COLUMN utterances.pii_masked_at IS '마지막 apply-mask 시각';
COMMENT ON COLUMN utterances.pii_masked_by IS '마지막 apply-mask를 실행한 admin user_id (auth.users.id)';
COMMENT ON COLUMN utterances.pii_masked_by_email IS '감사 편의용 — admin email 스냅샷';
COMMENT ON COLUMN utterances.pii_mask_version IS 'apply-mask 누적 적용 횟수 (재적용 추적)';
