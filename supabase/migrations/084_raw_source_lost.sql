-- 084_raw_source_lost.sql
-- 원본(raw) 오디오 소스 분실 마킹 — 기기에서 원본 파일이 삭제돼 영영 업로드 불가한 세션.
--
-- 배경:
--   both_agreed + raw_audio_url IS NULL 세션을 앱 폴러가 매 실행 재시도하는데,
--   옛 녹음(2024~2025)은 기기에서 원본이 이미 삭제돼 업로드가 영구 실패 → 무한 재시도 루프.
--   이 컬럼으로 "소스 없음"을 표시하고 pending-upload 쿼리에서 제외 → 재시도 중단.
--
-- 설정 경로:
--   - 디바이스가 파일 부재 확인 시 POST /api/sessions/raw-source-lost 로 durable 마킹(정밀).
--   - 운영 판단으로 옛 백로그 일괄 마킹(추론, reversible).
-- additive · schema only. 되돌리기 = raw_source_lost=false.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS raw_source_lost BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_sessions_raw_source_lost
  ON sessions(raw_source_lost) WHERE raw_source_lost = true;

COMMENT ON COLUMN sessions.raw_source_lost IS
  '기기 원본 파일 삭제로 raw 업로드 불가(소스 없음). true=pending-upload 제외. 되돌리기 가능.';
