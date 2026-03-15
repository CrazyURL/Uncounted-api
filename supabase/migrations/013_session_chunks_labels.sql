-- session_chunks에 labels JSONB 컬럼 추가
-- 라벨링 완료 후 청크 단위로 labels를 저장하기 위함

ALTER TABLE session_chunks
  ADD COLUMN IF NOT EXISTS labels JSONB;

CREATE INDEX IF NOT EXISTS idx_session_chunks_labels
  ON session_chunks USING GIN (labels);
