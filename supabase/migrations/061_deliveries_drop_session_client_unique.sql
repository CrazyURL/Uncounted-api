-- Migration 061: deliveries(session_id, client_id) UNIQUE 제거
--
-- Why:
--   STAGE 4-6 — 발화 단위 다중 매수자 정책 도입.
--   054 의 UNIQUE(session_id, client_id) 는 "같은 세션을 같은 client 에 1회만" 을 보장했지만,
--   060 에서 utterance_deliveries(utterance_id, client_id) UNIQUE 가 도입되면서
--   "발화 단위" 중복판매 차단으로 정책이 변경됨.
--
--   현 제약을 유지하면:
--     - day1: client X 에 session A 의 발화 1~5 납품 → POST 성공
--     - day2: client X 에 session A 의 발화 6~10 납품 시도 → 054 UNIQUE 위반 409
--   이는 발화 단위 분할 납품 운영 흐름을 막음.
--
--   결정: 054 의 session 레벨 UNIQUE 를 제거. 중복 방지는 utterance_deliveries(060) 에 위임.
--   같은 (session_id, client_id) 쌍에 대한 deliveries 레코드는 여러 건 가능 (각 건이 서로 다른
--   utterance 집합을 다룬다는 의미).
--
-- Safety:
--   - UNIQUE 제거는 ALTER 미사용, DROP INDEX 만으로 충분 (054 가 UNIQUE INDEX 로 정의).
--   - 기존 row 는 영향 없음 — 단지 신규 동일쌍 insert 가 허용될 뿐.
--   - 발화 중복은 utterance_deliveries.UNIQUE(utterance_id, client_id) 가 차단.

DROP INDEX IF EXISTS uniq_deliveries_session_client;

COMMENT ON TABLE deliveries IS
  '비배타적 라이선스 납품 기록. session 레벨 UNIQUE 제거(061) — 발화 단위 분할 납품 허용. '
  '중복판매 차단은 utterance_deliveries.UNIQUE(utterance_id, client_id) 가 담당.';
