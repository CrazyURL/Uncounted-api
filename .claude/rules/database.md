---
paths: supabase/**
---

# DB 마이그레이션 규칙

`supabase/migrations/` 디렉토리에 001~034번까지의 SQL 마이그레이션 파일.
새 마이그레이션 추가 시 번호를 순차적으로 증가 (예: `035_xxx.sql`).

034번: `fail_export_job(p_job_id UUID, p_error TEXT)` RPC — BU 잠금 해제 + export_jobs 상태를 'failed'로 원자적 처리 (SECURITY DEFINER).

주요 테이블:
- `sessions`, `session_chunks`, `transcripts`, `transcript_chunks` — 세션/전사
- `utterances` — 발화 단위 (세션→청크→발화 3계층, labels/label_source/label_confidence 포함)
- `users_profile` — 사용자 프로필 (age_band, gender, region_group)
- `voice_profiles` — 음성 등록 프로필
- `billable_units`, `bu_quality_metrics` — 과금 단위/품질
- `export_jobs`, `export_package_items` — 납품 패키지
- `metadata_events` — 클라이언트 메타데이터 (U-M01, U-M05~U-M18, U-P01)
- `user_asset_ledger`, `delivery_records` — 정산/납품
- `clients`, `delivery_profiles`, `client_sku_rules`, `sku_presets` — 클라이언트/SKU

데이터 소스 참조 규칙:
- **demographics** (age_band, gender, region_group): `users_profile` 테이블 (user_id 기준)
- **labels**: `utterances` 테이블 (발화 단위, sessions.labels는 미사용)
- **consent_status**: `billable_units` 테이블 (export 시 locked BU 기준)
