-- Migration 028: sessions에 audio_metrics JSONB 컬럼 추가
-- STT 완료 후 세션 전체 오디오 품질 요약 저장
-- { rms, silence_ratio, clipping_ratio, snr_db }

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS audio_metrics JSONB;
