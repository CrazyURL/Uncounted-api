---
paths: supabase/**
---

# DB 마이그레이션 규칙

`supabase/migrations/` 디렉토리에 001~037번까지의 SQL 마이그레이션 파일.
새 마이그레이션 추가 시 번호를 순차적으로 증가 (예: `038_xxx.sql`).

034번: `fail_export_job(p_job_id UUID, p_error TEXT)` RPC — BU 잠금 해제 + export_jobs 상태를 'failed'로 원자적 처리 (SECURITY DEFINER).
035번: `export_jobs.packaging_progress` 컬럼 추가 (패키징 진행 상태 추적).
036번: `utterances`에 PII 마스킹 감사 컬럼 5개 추가 — `pii_masked`, `pii_masked_at`, `pii_masked_by`, `pii_masked_by_email`, `pii_mask_version`. apply-mask 적용 이력 추적.
037번: `export_jobs`에 review sync 추적 컬럼 3개 추가 — `review_sync_status`(idle/syncing/done/failed), `review_sync_started_at`, `review_sync_error`. `reset_stuck_review_sync()` RPC (5분 stale 복구).

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
