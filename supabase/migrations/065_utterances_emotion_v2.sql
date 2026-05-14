-- STAGE 14 v2: emotion_category 제거, emotion → 3-class 직접 저장으로 변경
-- 064에서 추가된 emotion_category(파생 컬럼)를 제거하고
-- emotion 컬럼이 3-class(긍정|중립|부정)를 직접 저장하도록 정리

-- emotion_category 컬럼 및 인덱스 제거
DROP INDEX IF EXISTS idx_utterances_emotion_category;
ALTER TABLE utterances DROP COLUMN IF EXISTS emotion_category;

-- emotion 컬럼은 기존 063에서 추가된 것 유지 (긍정|중립|부정 직접 저장)
-- dialog_act_confidence, auto_label_model_version 컬럼도 063에서 추가됨 — 유지
