---
paths: supabase/**
---

# DB 마이그레이션 규칙

`supabase/migrations/` 디렉토리에 001~028번까지의 SQL 마이그레이션 파일.
새 마이그레이션 추가 시 번호를 순차적으로 증가 (예: `029_xxx.sql`).

주요 테이블:
- `sessions`, `session_chunks`, `transcripts`, `transcript_chunks` — 세션/전사
- `utterances` — 발화 단위 (세션→청크→발화 3계층, sequence_in_chunk/sequence_order 모두 1-based)
- `billable_units`, `bu_quality_metrics` — 과금 단위/품질
- `export_jobs`, `export_package_items` — 납품 패키지
- `metadata_events` — 클라이언트 메타데이터 (U-M01, U-M05~U-M18, U-P01)
- `user_asset_ledger`, `delivery_records` — 정산/납품
- `clients`, `delivery_profiles`, `client_sku_rules`, `sku_presets` — 클라이언트/SKU
