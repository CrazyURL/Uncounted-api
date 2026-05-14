-- Migration 067: session_segments — 주제 세그먼트 테이블
--
-- 발화 묶음 단위로 주제를 보관한다.
-- utterances.segment_id FK 는 Migration 068 에서 추가한다.

CREATE TABLE IF NOT EXISTS session_segments (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      TEXT        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    segment_index   INTEGER     NOT NULL,   -- 세션 내 순서 (0-based)
    topic           TEXT,                   -- 고정 30종 주제 레이블 또는 NULL
    start_ms        INTEGER,                -- 세그먼트 시작 시각 (ms)
    end_ms          INTEGER,                -- 세그먼트 종료 시각 (ms)
    utterance_count INTEGER     DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (session_id, segment_index)
);

CREATE INDEX IF NOT EXISTS idx_session_segments_session_id
    ON session_segments(session_id);
