-- Migration 066: session_speakers — 화자별 분석 결과 정규화 테이블
--
-- 화자 속성(성별, 음성 연령, 말투 연령, 관계)은 화자 단위 사실이므로
-- utterances 에 컬럼을 추가하는 대신 별도 테이블로 정규화한다.
-- utterances.session_speaker_id FK 가 이 테이블을 참조한다.

CREATE TABLE IF NOT EXISTS session_speakers (
    id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id                      TEXT        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    speaker_label                   TEXT        NOT NULL,   -- 'SPEAKER_00', 'SPEAKER_01', ...
    speaker_role                    TEXT,                   -- 'self' | 'other'
    speaker_role_source             TEXT,                   -- 'profile_match' | 'heuristic'
    speaker_gender                  TEXT,                   -- 'male' | 'female' | NULL(모호)
    speaker_voice_age_range         TEXT,                   -- '20대' | '30대' | '40대' | '50대+' | NULL
    speaker_speech_age_range        TEXT,                   -- '20대' | '30대' | '40대' | '50대+' | NULL
    speaker_speech_age_model_version TEXT,
    speaker_relation                TEXT,                   -- '부모' | '배우자' | '친구' | '직장상사' | '교사' | '형제자매' | NULL
    created_at                      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (session_id, speaker_label)
);

-- utterances 에 FK 컬럼 추가 (화자 분석 결과 참조)
ALTER TABLE utterances
    ADD COLUMN IF NOT EXISTS session_speaker_id UUID REFERENCES session_speakers(id) ON DELETE SET NULL;

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_session_speakers_session_id
    ON session_speakers(session_id);

CREATE INDEX IF NOT EXISTS idx_utterances_session_speaker_id
    ON utterances(session_speaker_id);
