-- Migration 055: BU 폐기 + 발화(utterance) 단위 정산 전환
--
-- Why:
--   BM v10 — "청구 단위(BU) 폐기, 발화(utterance) 단위 단일 기준" 결정.
--   billable_units · bu_quality_metrics · session_chunks 모두 폐기.
--   utterances 가 정산 단위로 단일화.
--
-- 단가 계산식 (마이그레이션 적용 후 백엔드 valueEngine 재작성):
--   payout_krw = utterance.duration_seconds × hourly_rate / 3600
--   hourly_rate = SKU별 differential (BASE_RATE 15K~45K/h × quality × compliance × 0.5 share)
--
-- ⚠️ CASCADE 사전 영향 검증 필수
--   본 마이그레이션 적용 전 아래 3개 쿼리를 실행해서 의존 객체 확인.
--   의도하지 않은 cascade 삭제가 없는지 운영자 검토 후 적용.
--
--   -- 1. 의존 뷰
--   SELECT table_schema, table_name, view_definition
--   FROM information_schema.views
--   WHERE view_definition ILIKE '%billable_units%'
--      OR view_definition ILIKE '%bu_quality_metrics%'
--      OR view_definition ILIKE '%session_chunks%';
--
--   -- 2. 의존 외래키
--   SELECT conname, conrelid::regclass AS table_name
--   FROM pg_constraint
--   WHERE confrelid IN (
--     'billable_units'::regclass,
--     'bu_quality_metrics'::regclass,
--     'session_chunks'::regclass
--   );
--
--   -- 3. 의존 RPC/함수
--   SELECT proname FROM pg_proc
--   WHERE prosrc ILIKE '%billable_units%'
--      OR prosrc ILIKE '%session_chunks%';

-- ────────────────────────────────────────────────────────────
-- 1. BU 테이블 폐기
-- ────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS bu_quality_metrics CASCADE;
DROP TABLE IF EXISTS billable_units CASCADE;

-- ────────────────────────────────────────────────────────────
-- 2. session_chunks 폐기 (utterance 단일 기준)
-- ────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS session_chunks CASCADE;

-- ────────────────────────────────────────────────────────────
-- 3. utterances 테이블에 정산 컬럼 추가
-- ────────────────────────────────────────────────────────────
ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS unit_price_krw INTEGER,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

-- 정산 조회용 인덱스
CREATE INDEX IF NOT EXISTS idx_utterances_settled_at ON utterances(settled_at);
CREATE INDEX IF NOT EXISTS idx_utterances_duration ON utterances(duration_seconds) WHERE duration_seconds IS NOT NULL;

COMMENT ON COLUMN utterances.duration_seconds IS
  '발화 길이 (초). end_ms - start_ms 환산. BM v10 정산 단위.';
COMMENT ON COLUMN utterances.unit_price_krw IS
  '발화 단가 (원). duration_seconds × hourly_rate / 3600 으로 백엔드에서 계산.';
COMMENT ON COLUMN utterances.settled_at IS
  '정산 완료 시각. NULL = 미정산. 매수자 납품 후 deliveries 와 매핑.';
