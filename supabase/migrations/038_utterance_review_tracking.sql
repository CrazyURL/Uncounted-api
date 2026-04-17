ALTER TABLE utterances ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_utt_reviewed ON utterances(reviewed_at);
CREATE INDEX IF NOT EXISTS idx_utt_session_reviewed ON utterances(session_id, reviewed_at);

-- 자동필터 제외 건 백필
UPDATE utterances
SET reviewed_at = created_at,
    reviewed_by = 'system:auto-filter'
WHERE exclude_reason IN ('too_short', 'low_grade', 'high_beep')
  AND reviewed_at IS NULL;

-- 수동 제외 건 백필 (검수자 불명 -> NULL)
UPDATE utterances
SET reviewed_at = COALESCE(updated_at, created_at),
    reviewed_by = NULL
WHERE review_status = 'excluded'
  AND exclude_reason = 'manual'
  AND reviewed_at IS NULL;
