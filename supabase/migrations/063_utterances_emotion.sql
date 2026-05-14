-- STAGE 14: 자동 감정/대화행위 라벨링 컬럼 추가
-- auto_label_service.py 가 STT 직후 채우는 필드
-- label_source 는 기존 컬럼 재활용 (새 값: auto_confirmed / auto_review / needs_review / admin_confirmed)

ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS emotion TEXT,                    -- 긍정 | 중립 | 부정
  ADD COLUMN IF NOT EXISTS emotion_confidence NUMERIC(4,3), -- 0.000–1.000
  ADD COLUMN IF NOT EXISTS dialog_act_confidence NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS auto_label_model_version TEXT;   -- e.g. v20250513_120000

-- label_source 새 값 설명 (기존 컬럼, CHECK 없음 — 유연성 유지):
--   'auto_confirmed'   — emotion_confidence >= 0.85, 자동 수락 (어드민 검수 불요)
--   'auto_review'      — 0.60 <= confidence < 0.85, 검토 권장
--   'needs_review'     — confidence < 0.60 또는 null, 어드민 확인 필요
--   'admin_confirmed'  — 어드민이 직접 확인·수정
--   (기존: 'user_confirmed', 'auto', 'auto:bulk_review' 등 유지)

CREATE INDEX IF NOT EXISTS idx_utterances_emotion
  ON utterances(emotion);

CREATE INDEX IF NOT EXISTS idx_utterances_label_source_review
  ON utterances(label_source)
  WHERE label_source IN ('needs_review', 'auto_review');
