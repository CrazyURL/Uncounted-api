-- Migration 068: utterances.segment_id — 067 이후 실행
--
-- session_segments 테이블(067) 이 먼저 존재해야 한다.

ALTER TABLE utterances
    ADD COLUMN IF NOT EXISTS segment_id UUID REFERENCES session_segments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_utterances_segment_id
    ON utterances(segment_id);
