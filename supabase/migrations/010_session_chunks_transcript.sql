-- ── session_chunks: transcript_text 컬럼 추가 ──────────────────────────────
-- 청크별 PII 마스킹된 STT 텍스트를 오디오와 함께 저장

ALTER TABLE session_chunks
  ADD COLUMN IF NOT EXISTS transcript_text TEXT;

COMMENT ON COLUMN session_chunks.transcript_text IS 'STT 추출 후 PII 마스킹된 청크 텍스트';
