-- ============================================================
-- Uncounted Migration v7 — 화자 인증 + 라벨 출처 컬럼 추가
-- 2026-02-28
-- ============================================================
-- sessionToRow / sessionToRowCore에서 사용하는 컬럼이 누락되어
-- Supabase upsert가 실패 → 관리자 페이지에 세션이 표시되지 않는 문제 수정

-- 화자 인증 (embeddingEngine)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS consent_status TEXT DEFAULT 'locked';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS verified_speaker BOOLEAN DEFAULT false;

-- 자동 라벨링 출처/신뢰도
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS label_source TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS label_confidence NUMERIC(3,2);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_sessions_consent_status ON sessions(consent_status);
CREATE INDEX IF NOT EXISTS idx_sessions_verified_speaker ON sessions(verified_speaker);
