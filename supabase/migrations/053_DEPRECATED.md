# Migration 053 — DEPRECATED

본 번호는 사용하지 않습니다.

## 폐기 이유

이전 안 (`delivery_records` UNIQUE constraint) 은
**비배타적 라이선스** 결정에 따라 폐기.

- 비배타적 라이선스: 같은 데이터를 여러 매수자에게 판매 가능, 단 동일 매수자에게는 1회만
- 결과: `delivery_records` 가 아닌 신규 `deliveries` 테이블에 `UNIQUE (session_id, client_id)` 제약 부여 (마이그레이션 054 참고)

## 처리

- SQL 파일은 만들지 않음
- 번호 053 은 건너뛰지 않고 본 폐기 메모로 남김
- 다음 마이그레이션은 054_deliveries_nonexclusive.sql

## 관련 결정

- 약관 v1.1 제18조 — "1회 판매" 조항을 "동일 매수자 1회 + 다른 매수자 추가 판매 가능" 으로 수정
- 마이그레이션 054 — `deliveries` 테이블 신설
