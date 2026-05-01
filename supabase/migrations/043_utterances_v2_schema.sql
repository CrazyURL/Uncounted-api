-- 데이터 스키마 v2.0 (Day 3, 2026-05-01) — utterances 컬럼 확장
--
-- legal/data_schema_v2.0.md 표준 반영:
--   1. duration_ms: AI-Hub 표준 ms 단위 (기존 duration_sec 보존, GENERATED)
--   2. speaker_id_int: AI-Hub 표준 정수 (0=user, 1=peer)
--      → 기존 speaker_id TEXT (SPEAKER_00 등 pyannote 출력)는 보존
--   3. start_ms / end_ms: 기존 start_sec / end_sec 보조
--
-- 마이그레이션 호환:
--   - 기존 컬럼은 모두 보존 (BREAKING CHANGE 없음)
--   - 신규 컬럼은 nullable 또는 GENERATED — packageBuilder export만 v2.0
--   - 기존 admin·label·STT 코드 영향 0

-- ── 1. ms 단위 컬럼 (GENERATED) ────────────────────────────────────────
-- duration_sec → duration_ms
ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER
    GENERATED ALWAYS AS ((duration_sec * 1000)::INTEGER) STORED;

-- start_sec → start_ms (start_sec가 nullable이라 GENERATED는 NULL 처리)
ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS start_ms INTEGER
    GENERATED ALWAYS AS (
      CASE WHEN start_sec IS NOT NULL THEN (start_sec * 1000)::INTEGER ELSE NULL END
    ) STORED;

ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS end_ms INTEGER
    GENERATED ALWAYS AS (
      CASE WHEN end_sec IS NOT NULL THEN (end_sec * 1000)::INTEGER ELSE NULL END
    ) STORED;

-- ── 2. speaker_id 정수형 (AI-Hub 표준) ────────────────────────────────
-- 기존 speaker_id TEXT (SPEAKER_00, SPEAKER_01 등)는 그대로 보존.
-- 신규 speaker_id_int: pyannote SPEAKER_NN → 0/1 변환 (utterance_segmenter에서 채움)
-- 변환 규칙: is_user=true → 0, is_user=false → 1, NULL이면 NULL
ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS speaker_id_int INTEGER
    GENERATED ALWAYS AS (
      CASE
        WHEN is_user IS TRUE THEN 0
        WHEN is_user IS FALSE THEN 1
        ELSE NULL
      END
    ) STORED;

-- ── 3. 인덱스 (필요 시) ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_utterances_speaker_id_int
  ON utterances(speaker_id_int)
  WHERE speaker_id_int IS NOT NULL;

-- ── 4. 코멘트 ──────────────────────────────────────────────────────────
COMMENT ON COLUMN utterances.duration_ms IS
  'v2.0 (2026-05-01): ms 단위 — AI-Hub 표준 호환. duration_sec * 1000.';

COMMENT ON COLUMN utterances.speaker_id_int IS
  'v2.0 (2026-05-01): 0=user, 1=peer. AI-Hub 표준 정수형. 기존 speaker_id TEXT(SPEAKER_NN)는 보존.';

COMMENT ON COLUMN utterances.start_ms IS 'v2.0 ms 단위 (start_sec * 1000)';
COMMENT ON COLUMN utterances.end_ms IS 'v2.0 ms 단위 (end_sec * 1000)';
