---
paths: supabase/**
---

# DB 마이그레이션 규칙

`supabase/migrations/` 디렉토리에 001~024번까지의 SQL 마이그레이션 파일.
새 마이그레이션 추가 시 번호를 순차적으로 증가 (예: `025_xxx.sql`).

주요 테이블:
- `sessions`, `session_chunks`, `transcripts`, `transcript_chunks` — 세션/전사
- `billable_units`, `bu_quality_metrics` — 과금 단위/품질
- `export_jobs`, `export_package_items` — 납품 패키지
- `metadata_events` — 클라이언트 메타데이터 (U-M05~U-M18, U-P01)
- `user_asset_ledger`, `delivery_records` — 정산/납품
- `clients`, `delivery_profiles`, `client_sku_rules`, `sku_presets` — 클라이언트/SKU
