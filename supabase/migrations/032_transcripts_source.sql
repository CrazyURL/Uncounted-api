-- 032: transcripts 테이블에 source 컬럼 추가 (device/server 구분)
ALTER TABLE public.transcripts
  ADD COLUMN IF NOT EXISTS source text NULL;

COMMENT ON COLUMN public.transcripts.source IS 'STT 처리 출처: device (온디바이스 Moonshine) 또는 server (Voice API WhisperX)';
