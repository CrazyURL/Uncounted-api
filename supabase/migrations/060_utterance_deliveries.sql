-- Migration 060: utterance_deliveries — 발화 단위 납품 추적 (중복판매 방지)
--
-- Why:
--   BM v10 — 발화(utterance) 단위로 데이터셋이 판매됨. 054 의 deliveries 는 session 단위였으나,
--   실제 납품 판매는 발화 묶음 단위가 더 정확.
--   중복판매 방지 규칙 (사용자 결정 2026-05-10):
--     - 다자 납품 가능 (동일 발화를 여러 클라이언트에 각각 판매 가능)
--     - **단, 동일 클라이언트에는 동일 발화 1회만** — UNIQUE(utterance_id, client_id)
--
-- 관계:
--   deliveries(id) — 1건의 납품 transaction (납품처 + 매출금액 + 시점)
--   utterance_deliveries — 그 transaction 에 포함된 발화 N건 (junction)
--   1 delivery ←→ N utterances, 1 utterance ←→ N deliveries (N:M)
--
-- 보안:
--   - RLS: admin (JWT app_metadata.role='admin') 만 ALL — 매출 + 사용 이력은 운영 전용
--   - service_role bypass

CREATE TABLE IF NOT EXISTS utterance_deliveries (
  utterance_id TEXT NOT NULL REFERENCES utterances(id) ON DELETE RESTRICT,
  delivery_id  UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL REFERENCES clients(id)    ON DELETE RESTRICT,
  sold_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price_share_krw INTEGER CHECK (price_share_krw IS NULL OR price_share_krw >= 0),
  PRIMARY KEY (utterance_id, delivery_id)
);

-- 핵심 제약: 동일 client 에 동일 utterance 재납품 불가 (다른 client 는 OK)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_utterance_deliveries_utt_client
  ON utterance_deliveries (utterance_id, client_id);

-- 조회 인덱스
CREATE INDEX IF NOT EXISTS idx_utterance_deliveries_client_id
  ON utterance_deliveries(client_id);
CREATE INDEX IF NOT EXISTS idx_utterance_deliveries_delivery_id
  ON utterance_deliveries(delivery_id);
CREATE INDEX IF NOT EXISTS idx_utterance_deliveries_sold_at
  ON utterance_deliveries(sold_at DESC);

-- RLS
ALTER TABLE utterance_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "utterance_deliveries_admin_all" ON utterance_deliveries;
CREATE POLICY "utterance_deliveries_admin_all" ON utterance_deliveries
  FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

COMMENT ON TABLE utterance_deliveries IS
  '발화 단위 납품 기록 (junction). 다자 납품 가능, 단 동일 client 에 동일 utterance 재납품 금지 (UNIQUE utterance_id+client_id).';
COMMENT ON COLUMN utterance_deliveries.utterance_id IS
  '납품된 발화. utterances(id) FK. ON DELETE RESTRICT — 납품 이력 있는 발화는 삭제 차단.';
COMMENT ON COLUMN utterance_deliveries.delivery_id IS
  '소속 납품 transaction. deliveries(id) FK. CASCADE — 납품 취소 시 발화 매핑 자동 삭제.';
COMMENT ON COLUMN utterance_deliveries.client_id IS
  '납품처 (denormalized — deliveries.client_id 와 동일하지만 빠른 중복판매 검사용).';
COMMENT ON COLUMN utterance_deliveries.price_share_krw IS
  '발화 1건의 분배 금액 (원). 미입력 시 deliveries.price_krw 를 발화 수로 균등분배 가정.';
