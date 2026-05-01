-- 데이터 스키마 v2.0 (Day 6, 2026-05-01) — utterances slot 컬럼 (BM v9.0 단계 2~3)
--
-- legal/data_schema_v2.0.md 정의 16 객체 중 "slot only" 카테고리:
--   - noise_environment: 11 카테고리 enum (지금은 nullable, 데이터 채움은 단계 2)
--   - taxonomy: 3-level 분류 (지금은 nullable, 단계 2 SaaS API 결정 후 채움)
--
-- 본 마이그레이션은 컬럼만 추가 — packageBuilder는 nullable 그대로 export.
-- 실제 값 채움 로직은 BM v9.0 단계 2 (UC-A2 정식 출시) 시.

-- ── noise_environment slot ────────────────────────────────────────────
-- 11 카테고리 enum (legal/data_schema_v2.0.md 2.9 noise_env 정의):
--   indoor_quiet / indoor_noisy / outdoor_traffic / outdoor_other /
--   vehicle / public_transport / cafe / office / home / unknown / other
ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS noise_category TEXT
    CHECK (noise_category IS NULL OR noise_category IN (
      'indoor_quiet', 'indoor_noisy', 'outdoor_traffic', 'outdoor_other',
      'vehicle', 'public_transport', 'cafe', 'office', 'home', 'unknown', 'other'
    ));

COMMENT ON COLUMN utterances.noise_category IS
  'v2.0 (2026-05-01): 11 카테고리 noise enum. nullable. 단계 2 (UC-A2)에서 자동 분류기로 채움.';

-- ── taxonomy slot (3-level) ───────────────────────────────────────────
ALTER TABLE utterances
  ADD COLUMN IF NOT EXISTS taxonomy_level1 TEXT,
  ADD COLUMN IF NOT EXISTS taxonomy_level2 TEXT,
  ADD COLUMN IF NOT EXISTS taxonomy_level3 TEXT;

COMMENT ON COLUMN utterances.taxonomy_level1 IS
  'v2.0 (2026-05-01): 도메인 대분류 (예: 통화/회의/상담). 단계 2 SaaS API 결정 후 채움.';
COMMENT ON COLUMN utterances.taxonomy_level2 IS 'v2.0: 중분류 (예: 고객지원/일상)';
COMMENT ON COLUMN utterances.taxonomy_level3 IS 'v2.0: 소분류 (자유 입력)';

-- ── 인덱스 (선택적 필터 — 단계 2 이후 활용) ──────────────────────────
CREATE INDEX IF NOT EXISTS idx_utterances_noise_category
  ON utterances(noise_category) WHERE noise_category IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_utterances_taxonomy_level1
  ON utterances(taxonomy_level1) WHERE taxonomy_level1 IS NOT NULL;
