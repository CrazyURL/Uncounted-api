-- Migration 074: AI Hub-aligned export v2 columns (8 columns)
--
-- 창 A 작업 범위. SPEC §4.8.1 참조.
-- 외부 검토 + 사용자 결정 (2026-05-18): utterances 2 + sessions 6 = 8 컬럼 확정.
--
-- 안전선 #5 (광의): session_dataset_eligible DEFAULT false.
--   → 074 적용 직후 전 세션 export-ineligible 상태.
--   → 창 B (gpu-worker) 가 품질/동의/리뷰 평가 후 true 세팅하는 staged rollout.
--   → isExportEligible() 의 `session_dataset_eligible !== false` 검사는
--     false 값일 때만 차단 (NULL 통과). 074 직후 false 기본값으로 인해
--     전 세션 차단되는 것은 의도된 게이트.
--
-- 이연/거부:
--   - speech_act 별도 컬럼 X (기존 speech_act_events / migration 029 재사용)
--   - emotion_detail X (모델 미존재, 075+ 이연)
--   - boolean 4종 개별 컬럼 X (utterance_form JSONB 통합)

-- ── utterances 신규 2 컬럼 ──────────────────────────────────────────────
ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS numeric_patterns JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS utterance_form   JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_utterances_numeric_patterns
  ON utterances USING GIN (numeric_patterns);

CREATE INDEX IF NOT EXISTS idx_utterances_utterance_form
  ON utterances USING GIN (utterance_form);

-- ── sessions 신규 6 컬럼 ────────────────────────────────────────────────
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS audio_metadata           JSONB   DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS conversation_context     JSONB   DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS support_quality_labels   JSONB   DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS session_topic_summary    TEXT,
  ADD COLUMN IF NOT EXISTS session_quality_tier     TEXT,
  ADD COLUMN IF NOT EXISTS session_dataset_eligible BOOLEAN DEFAULT false;

-- session_quality_tier CHECK (마이그레이션 재실행 시 중복 방지)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'sessions'
      AND constraint_name = 'sessions_session_quality_tier_check'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_session_quality_tier_check
      CHECK (session_quality_tier IN ('A', 'B', 'C') OR session_quality_tier IS NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_dataset_eligible
  ON sessions(session_dataset_eligible)
  WHERE session_dataset_eligible = true;

-- 검증:
--   SELECT table_name, column_name FROM information_schema.columns
--   WHERE table_name IN ('utterances', 'sessions')
--     AND column_name IN (
--       'numeric_patterns','utterance_form','audio_metadata',
--       'conversation_context','support_quality_labels',
--       'session_topic_summary','session_quality_tier','session_dataset_eligible'
--     )
--   ORDER BY table_name, column_name;
--   기대: 8 row
