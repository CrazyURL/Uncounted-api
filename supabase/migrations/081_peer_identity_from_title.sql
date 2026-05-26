-- 081_peer_identity_from_title.sql
-- 상대(counterparty) identity peer 키 — sessions.title 파싱 bootstrap (schema only).
--
-- 목적:
--   휴대폰 원본 통화녹음 파일명 `통화 녹음 {id}_YYMMDD_HHMMSS`(sessions.title)에 보존된
--   상대 식별자({id}=연락처 이름 또는 전화번호)를 해시 키로 적재할 수 있게 peers 확장.
--   관계 라벨 추론·전파의 선행 블로커(sessions.peer_id 0/1026, peers 0행) 해소용.
--   설계: scripts/analysis/relationship_identity_from_title_finding_20260526.md
--         + design_relationship_counterparty_profile_20260526.md §7(peers 매핑/갭표)
--
-- 핵심 불변식 (헷갈림 방지):
--   peers.peer_identity_hash = HMAC(user_id|kind|normalized_id) — dedup/멱등 키.
--                              raw 이름/번호는 절대 저장하지 않는다(해시만).
--   peers.id                 = 불투명 PK(gen_random_uuid). identity 해시를 id 로 쓰지 않는다.
--   peers.display_name       = 비식별 토큰 `상대#<hash8>`(NOT NULL 충족). raw 표시명 금지.
--   peers.relationship/rel_* = 관계 트랙 소관 — 본 마이그/backfill 이 절대 쓰지 않는다(default 유지).
--
-- 키 품질:
--   identity_kind='title_phone' → 강키(identity_confidence=0.90), phone_hash 동반.
--   identity_kind='title_name'  → 약키(0.50, 동명이인·표기변형 위험), phone_hash=NULL.
--
-- 이 마이그는 schema only (additive). 키 산출(HMAC)·적재는 전부 애플리케이션/스크립트.
-- ⚠ 이 마이그는 sessions.peer_id 를 채우지 않는다 — backfill --apply(별도 승인) 에서만.

ALTER TABLE peers ADD COLUMN IF NOT EXISTS peer_identity_hash  TEXT;
ALTER TABLE peers ADD COLUMN IF NOT EXISTS identity_kind       TEXT;          -- title_name | title_phone
ALTER TABLE peers ADD COLUMN IF NOT EXISTS identity_confidence NUMERIC(3,2);  -- phone=0.90 / name=0.50
ALTER TABLE peers ADD COLUMN IF NOT EXISTS identity_source     TEXT;          -- 'title_parse'

-- id 를 불투명하게 유지 (현재 peers writer 0건 — 안전). insert 시 미공급 → DB 생성.
ALTER TABLE peers ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

COMMENT ON COLUMN peers.peer_identity_hash IS
  'HMAC(secret, user_id|kind|normalized_id) — sessions.title 파싱 dedup 키. raw PII 미저장.';
COMMENT ON COLUMN peers.identity_kind IS
  'title_name | title_phone — 상대 identity 출처/키 종류.';
COMMENT ON COLUMN peers.identity_confidence IS
  'identity 키 신뢰도. title_phone=0.90(강키) / title_name=0.50(약키).';
COMMENT ON COLUMN peers.identity_source IS
  'identity 적재 경로. title 파싱 bootstrap = ''title_parse''.';

-- 멱등 upsert conflict target: (user_id, peer_identity_hash). 일반 unique(partial 아님).
CREATE UNIQUE INDEX IF NOT EXISTS uq_peers_user_identity
  ON peers(user_id, peer_identity_hash);

CREATE INDEX IF NOT EXISTS idx_peers_identity_kind ON peers(identity_kind);
