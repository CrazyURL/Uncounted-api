-- 012_transcript_chunks_words.sql
-- transcript_chunks 테이블에 words(단어별 타임스탬프) 컬럼 추가

ALTER TABLE transcript_chunks
  ADD COLUMN IF NOT EXISTS words JSONB;

-- words 구조: [{word, start, end, probability}] — 청크 기준 상대 timestamp (청크 시작 = 0초)
-- 예시:
-- [
--   {"word": "안녕하세요", "start": 0.0,  "end": 0.52, "probability": 0.97},
--   {"word": "오늘",       "start": 0.56, "end": 0.81, "probability": 0.93}
-- ]
