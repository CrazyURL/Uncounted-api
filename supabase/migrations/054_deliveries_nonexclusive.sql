-- Migration 054: deliveries 테이블 신설 (비배타적 라이선스)
--
-- Why:
--   BM v10 — 비배타적 라이선스 결정 (같은 데이터를 여러 매수자에게 판매 가능, 단 동일 매수자 1회만)
--   에 따라 (session_id, client_id) UNIQUE 제약을 가진 신규 deliveries 테이블 신설.
--   기존 delivery_records 는 BM v9 잔존 — 시드 이후 폐기 검토.
--
-- 옵션 A 결정 (시드 단순화):
--   049 v5 의 calls 테이블 도입 보류. sessions 가 통화 단위 역할 겸함.
--   본 마이그레이션의 deliveries.session_id 는 sessions(id) 직접 참조 (calls 우회).
--   fingerprint·ambiguous_matches·call_clusters 모두 M3+ 보류.
--
-- 049 v5 적용 여부 사전 확인:
--   SELECT EXISTS (
--     SELECT 1 FROM information_schema.tables
--     WHERE table_schema='public' AND table_name='calls'
--   );
--   → true 면 049 v5 가 이미 적용됨 (admin UI 에서 calls·contracts·transactions 무시 정책 적용)
--   → false 면 049 v5 미적용 (deliveries 만 단독 사용)
--
-- 보안:
--   - RLS: 운영자 (role='admin') 만 ALL 권한
--   - service_role bypass 는 anon 기본
--   - 사용자(non-admin) 접근 차단 — 매출 정보는 운영 전용

-- ⚠️ FK 타입 매칭 (BM v9 잔존):
--   public.sessions.id = TEXT  → deliveries.session_id = TEXT
--   public.clients.id  = TEXT  → deliveries.client_id  = TEXT
--   auth.users.id      = UUID  → deliveries.delivered_by = UUID
--   PostgreSQL 외래키는 양쪽 타입이 일치해야 함. UUID 값은 TEXT 컬럼에 정상 저장 가능 (호환).
CREATE TABLE IF NOT EXISTS deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price_krw INTEGER NOT NULL CHECK (price_krw >= 0),
  delivered_by UUID REFERENCES auth.users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 비배타적 라이선스 핵심 제약 (같은 session 을 같은 client 에 1회만)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_deliveries_session_client
  ON deliveries (session_id, client_id);

-- 조회 인덱스
CREATE INDEX IF NOT EXISTS idx_deliveries_client_id ON deliveries(client_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_session_id ON deliveries(session_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_delivered_at ON deliveries(delivered_at DESC);

-- RLS — 운영자 전용
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deliveries_admin_all" ON deliveries;
CREATE POLICY "deliveries_admin_all" ON deliveries
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid()
        AND (u.raw_app_meta_data ->> 'role') = 'admin'
    )
  );

DROP POLICY IF EXISTS "deliveries_service_role" ON deliveries;
CREATE POLICY "deliveries_service_role" ON deliveries
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

COMMENT ON TABLE deliveries IS
  '비배타적 라이선스 납품 기록. UNIQUE(session_id, client_id) — 같은 session 을 같은 client 에 1회만, 다른 client 에는 재납품 가능.';
COMMENT ON COLUMN deliveries.session_id IS
  '납품 대상 세션. 옵션 A 결정으로 calls 테이블 미사용, sessions 직접 참조.';
COMMENT ON COLUMN deliveries.price_krw IS
  '매출 금액 (원). 50:50 분배는 별도 계산 시 적용.';
COMMENT ON COLUMN deliveries.delivered_by IS
  '납품 처리한 운영자 (auth.users) — 감사 추적용.';
