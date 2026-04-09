-- Migration 029: U-A03 필드 추가
-- speech_act_events: 발화 내 대화행위 이벤트 배열 (U-A03)
-- interaction_mode: 상호작용 모드 (U-A03)

ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS speech_act_events JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS interaction_mode TEXT;
