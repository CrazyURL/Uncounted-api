-- Migration 062: sessions.session_seq (admin display_title 합성 기반)
--
-- Why:
--   STAGE 6 — admin UI 휴리스틱 마스킹(displayMask.ts) 결함 해결.
--   "녹음"의 "녹"이 한국 성씨 set 에 잘못 매칭되어 "녹*"가 되거나,
--   "종일이형"의 "종"이 set 에 없어 마스킹 누락 → PII leak.
--
--   해결: admin 응답에서 raw title 노출 X. 대신 합성 display_title 사용:
--     "통화#{seq} · {YYYY-MM-DD} · {duration}"
--     예) "통화#000042 · 2026-05-02 · 30초"
--
--   seq 는 created_at 순 단조 증가. 본 마이그가 신규 컬럼 + sequence + 백필 + DEFAULT 설정.
--
-- 정책:
--   - title 컬럼은 그대로 유지 (App 본인 폰 raw 표시 + 백엔드 검색 매칭 용)
--   - admin 응답 select 절에서 title 제외 (코드에서 보장)
--   - display_title 은 컬럼 X, API 응답 매핑 시 동적 합성 (lib/displayTitle.ts)
--
-- 검증 (적용 후):
--   SELECT COUNT(*) FROM sessions WHERE session_seq IS NULL;  -- → 0
--   SELECT setval('sessions_session_seq_seq');  -- → max session_seq + 1
--   신규 insert 후 session_seq 자동 채워지는지

-- 1. sequence 생성
CREATE SEQUENCE IF NOT EXISTS sessions_session_seq_seq START 1;

-- 2. 컬럼 추가 (NULL 허용 — 백필 후 NOT NULL 강제 가능)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_seq BIGINT;

-- 3. 기존 row 백필 — created_at 순으로 1, 2, 3, ... 부여
--    id 를 tie-break 로 추가 (동일 created_at 시 결정성)
UPDATE sessions
SET session_seq = subq.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
  FROM sessions
) subq
WHERE sessions.id = subq.id
  AND sessions.session_seq IS NULL;

-- 4. sequence 를 max + 1 로 동기화 (신규 insert 가 max 이후부터 시작)
SELECT setval(
  'sessions_session_seq_seq',
  GREATEST((SELECT COALESCE(MAX(session_seq), 0) FROM sessions), 1),
  true  -- 다음 nextval() 호출 시 max+1 반환
);

-- 5. DEFAULT 설정 — 신규 insert 시 자동 채움
ALTER TABLE sessions ALTER COLUMN session_seq SET DEFAULT nextval('sessions_session_seq_seq');

-- 6. UNIQUE 인덱스 (정렬/조회 + 충돌 방어)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_seq ON sessions(session_seq);

COMMENT ON COLUMN sessions.session_seq IS
  'admin display_title 합성용 단조증가 일련번호. STAGE 6(2026-05) 도입. '
  '응답 형식: "통화#{session_seq:06} · {created_at:date} · {duration}".';
