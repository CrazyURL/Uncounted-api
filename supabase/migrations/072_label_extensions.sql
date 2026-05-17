-- Migration 072: utterances 라벨 컬럼 확장 + session_speakers 추론 컬럼
-- Tier A (즉시 도출 가능한 통계 라벨)
ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS speech_rate_wpm      NUMERIC,
  ADD COLUMN IF NOT EXISTS silence_before_sec   NUMERIC,
  ADD COLUMN IF NOT EXISTS filler_word_count    INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confidence_tier      TEXT
    CHECK (confidence_tier IN ('auto_confirmed', 'auto_review', 'needs_review', 'admin_confirmed')),
  ADD COLUMN IF NOT EXISTS audio_quality_class  TEXT
    CHECK (audio_quality_class IN ('excellent', 'good', 'fair', 'poor'));

-- Tier B (언어적 특성 라벨)
ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS honorific_level      TEXT
    CHECK (honorific_level IN ('honorific', 'casual', 'mixed', 'unknown')),
  ADD COLUMN IF NOT EXISTS politeness_score     NUMERIC,
  ADD COLUMN IF NOT EXISTS question_type        TEXT
    CHECK (question_type IN ('yes_no', 'wh', 'choice', 'confirmation', 'rhetorical', 'unknown', 'na')),
  ADD COLUMN IF NOT EXISTS interruption_flag    BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS language_mix_flag    TEXT
    CHECK (language_mix_flag IN ('korean', 'english', 'mixed', 'other'));

-- Tier C (미래 ML 모델용 JSONB 슬롯 — 현재 not_available 플레이스홀더)
ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS intent               JSONB DEFAULT
    '{"value": null, "confidence": null, "method": "not_available", "version": "intent_v0"}'::jsonb,
  ADD COLUMN IF NOT EXISTS satisfaction_score   JSONB DEFAULT
    '{"value": null, "scale": "1-5", "confidence": null, "method": "not_available", "version": "sat_v0"}'::jsonb,
  ADD COLUMN IF NOT EXISTS escalation_flag      JSONB DEFAULT
    '{"value": null, "confidence": null, "method": "not_available", "version": "esc_v0"}'::jsonb,
  ADD COLUMN IF NOT EXISTS dialect_region       JSONB DEFAULT
    '{"value": null, "confidence": null, "method": "not_available", "version": "dialect_v0"}'::jsonb,
  ADD COLUMN IF NOT EXISTS noise_class          JSONB DEFAULT
    '{"value": null, "confidence": null, "method": "not_available", "version": "noise_v0"}'::jsonb,
  ADD COLUMN IF NOT EXISTS fluency_score        JSONB DEFAULT
    '{"value": null, "scale": "1-5", "confidence": null, "method": "not_available", "version": "fluency_v0"}'::jsonb,
  ADD COLUMN IF NOT EXISTS toxicity_label       JSONB DEFAULT
    '{"value": null, "confidence": null, "method": "not_available", "version": "toxicity_v0", "disclaimer": "Sensitive label. Not generated in this version."}'::jsonb;

-- session_speakers: 확률형 identity inference + 음향 기반 추정 JSONB 슬롯
ALTER TABLE session_speakers
  ADD COLUMN IF NOT EXISTS speaker_identity_inference  JSONB DEFAULT
    '{"predicted_role": null, "owner_probability": null, "counterparty_probability": null, "confidence": null, "method": "not_available", "status": "not_available", "counterparty_count": null, "note": "Speaker identity is probabilistic and not guaranteed."}'::jsonb,
  ADD COLUMN IF NOT EXISTS speaker_gender_estimate     JSONB DEFAULT
    '{"value": null, "confidence": null, "method": "not_available", "disclaimer": "Inferred from acoustic features only"}'::jsonb,
  ADD COLUMN IF NOT EXISTS speaker_age_group_estimate  JSONB DEFAULT
    '{"value": null, "confidence": null, "method": "not_available", "disclaimer": "Inferred from acoustic features only"}'::jsonb;

-- quality_score 스케일 통일: 기존 0~1 데이터 → 0~100 변환
UPDATE utterances
SET quality_score = quality_score * 100
WHERE quality_score IS NOT NULL AND quality_score <= 1;
