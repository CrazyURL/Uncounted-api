-- Migration 077: utterances 납품 품질 검수 상태 컬럼 추가
--
-- 저품질(C) 필터를 "발화 단위 납품 품질 검수 큐"로 확장하기 위한 전용 상태 컬럼.
-- 설계 문서: scripts/analysis/design_quality_review_queue_20260523.md
--
-- ⚠️ 기존 review_status(일반 검수 pending/excluded)와 직교(별개)다.
--    quality_review_status 는 "납품 포함/제외 판단" 전용이며,
--    원본 데이터의 일반 검수 승인/거절 상태가 아니다.
--    review_status=approved 와 quality_review_status=excluded_low_quality 가 공존 가능해야 한다.
--
-- 기존 status 컬럼들은 TEXT+CHECK 방식 (enum 미사용, migration 052/070 참조).

ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS quality_review_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS quality_exclusion_reason TEXT,
  ADD COLUMN IF NOT EXISTS quality_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quality_reviewed_by TEXT,
  ADD COLUMN IF NOT EXISTS quality_review_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'utterances_quality_review_status_check') THEN
    ALTER TABLE utterances ADD CONSTRAINT utterances_quality_review_status_check
      CHECK (quality_review_status IN (
        'pending',
        'approved_exception',
        'excluded_low_quality',
        'needs_retranscription',
        'needs_pii_masking',
        'needs_transcript_edit'
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'utterances_quality_exclusion_reason_check') THEN
    ALTER TABLE utterances ADD CONSTRAINT utterances_quality_exclusion_reason_check
      CHECK (quality_exclusion_reason IS NULL OR quality_exclusion_reason IN (
        'noisy',
        'too_short',
        'clipped',
        'unintelligible',
        'wrong_transcript',
        'pii_unresolved',
        'duplicate',
        'other'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_utt_quality_review ON utterances(quality_review_status);

COMMENT ON COLUMN utterances.quality_review_status IS '납품 품질 검수 상태 (pending/approved_exception/excluded_low_quality/needs_retranscription/needs_pii_masking/needs_transcript_edit). 일반 review_status 와 직교 — 납품 포함/제외 판단 전용이며 review_status 변경을 의미하지 않음. A/B 등급은 pending 이어도 기본 납품 후보, C 등급은 pending 이면 보류이고 approved_exception 일 때만 조건부 포함.';
COMMENT ON COLUMN utterances.quality_exclusion_reason IS '품질 제외/보류 사유 (noisy/too_short/clipped/unintelligible/wrong_transcript/pii_unresolved/duplicate/other). 일반 exclude_reason 과 별개. excluded_low_quality 판정 시 필수.';
COMMENT ON COLUMN utterances.quality_reviewed_at IS '품질 검수 판정 시각.';
COMMENT ON COLUMN utterances.quality_reviewed_by IS '품질 검수 판정자 user id.';
COMMENT ON COLUMN utterances.quality_review_note IS '품질 검수 메모 (선택). 예외 승인/제외 사유 자유 기술.';
