-- STAGE 14: emotion_category 컬럼 추가
-- emotion(7종 세부감정) 에서 파생된 상위 카테고리 (긍정|중립|부정)
-- auto_label_service.py 가 emotion 예측 후 EMOTION_TO_CATEGORY 매핑으로 채움

ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS emotion_category TEXT; -- 긍정 | 중립 | 부정 (emotion 파생값)

-- 기존 063번의 emotion 컬럼 comment 보정:
-- emotion TEXT 는 세부감정 7종 (기쁨|놀람|슬픔|분노|불안|당황|중립) 을 저장
-- emotion_category TEXT 는 이를 3종으로 집계한 상위 카테고리를 저장
-- (기쁨·놀람 → 긍정 / 슬픔·분노·불안·당황 → 부정 / 중립 → 중립)

CREATE INDEX IF NOT EXISTS idx_utterances_emotion_category
  ON utterances(emotion_category);
