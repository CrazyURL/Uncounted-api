-- 083_dialog_act_group.sql
-- utterances.dialog_act_group — 9-group 화행(supervised head 산출) 적재 컬럼.
--
-- 배경:
--   기존 utterances.dialog_act(15종)은 Ollama heuristic_mvp 산출이고, export 가
--   DIALOG_ACT_TO_GROUP_v1 으로 15→9 변환해 노출해 왔다. 학습된 supervised head
--   (models/speech_act/v20260606_083238, KR-ELECTRA, holdout macro-F1 0.61)는
--   9-group 을 직접 산출하므로 전용 컬럼이 필요하다(15종 컬럼엔 9-group 값이 enum 위반).
--   설계: docs/PLAN_aihub_dialog_act_goldset.md §2(9-group 통일), §6(provenance).
--
-- 불변식:
--   dialog_act_group         = 9-group 정본(SPEC §5.1.4 DIALOG_ACT_TO_GROUP_v1).
--                              순서·표면형은 transforms.ts DialogActGroup 과 일치.
--   dialog_act_group_source  = 'supervised_model'(head) — heuristic_mvp(LLM)와 구분.
--                              내부 모델명/버전은 미저장(안전선 #6, export 에서 일반화).
--   기존 dialog_act(15종)/dialog_act_confidence 는 보존(폴백·하위호환).
--
-- 이 마이그는 schema only(additive). 적재는 CPU 백필 스크립트가 수행(GPU 미사용).

ALTER TABLE utterances ADD COLUMN IF NOT EXISTS dialog_act_group            TEXT;
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS dialog_act_group_confidence NUMERIC(4,3);
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS dialog_act_group_source     TEXT;

-- 9-group 정본 enum 가드(정본 외 값 차단 → 잘못 쓰면 23514 로 즉시 실패, 조용한 오염 방지).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'utterances_dialog_act_group_check'
  ) THEN
    ALTER TABLE utterances ADD CONSTRAINT utterances_dialog_act_group_check
      CHECK (dialog_act_group IS NULL OR dialog_act_group IN (
        '정보', '질문/확인', '요청/제안', '감사/사과',
        '사회적', '응답', '지시', '감정 표현', '기타'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_utterances_dialog_act_group_null
  ON utterances (session_id) WHERE dialog_act_group IS NULL;

COMMENT ON COLUMN utterances.dialog_act_group IS
  '9-group 화행(SPEC §5.1.4). supervised head 산출. 15종 dialog_act 와 별개.';
COMMENT ON COLUMN utterances.dialog_act_group_source IS
  'supervised_model(head) | heuristic(폴백). 내부 모델명/버전 미저장.';
