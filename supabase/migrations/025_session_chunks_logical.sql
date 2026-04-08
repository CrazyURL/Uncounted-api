-- Migration 025: session_chunks 논리 청크 확장
-- v3에서 session_chunks를 논리 청크(WAV 없음, 발화 묶음)로도 사용.
-- 레거시(chunk_type='wav')와 신규(chunk_type='logical') 공존.

-- 논리 청크용 컬럼 추가
ALTER TABLE session_chunks ADD COLUMN IF NOT EXISTS utterance_count INTEGER DEFAULT 0;
ALTER TABLE session_chunks ADD COLUMN IF NOT EXISTS total_utterance_duration NUMERIC(10,3);
ALTER TABLE session_chunks ADD COLUMN IF NOT EXISTS chunk_type TEXT DEFAULT 'wav';
  -- 'wav': 레거시 (물리 WAV 존재)
  -- 'logical': v3 (WAV 없음, 발화 묶음)

-- 논리 청크는 WAV 파일이 없으므로 storage_path NOT NULL 제거
ALTER TABLE session_chunks ALTER COLUMN storage_path DROP NOT NULL;
