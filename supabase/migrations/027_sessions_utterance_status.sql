-- Migration 027: sessions 테이블에 발화 상태 컬럼 추가
-- v3 발화 업로드 진행 상태를 세션 단위로 추적.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utterance_count INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utterance_upload_status TEXT DEFAULT 'none';
  -- 'none' | 'uploading' | 'complete' | 'partial'
