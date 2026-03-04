# 2. DB 스키마 정의서 (v1.3)

> Uncounted Client — CTO 인수인계 문서 (2026-03-02)
> v1.3 — 물리 DB 대조 기반 보완: 레거시 테이블 11개 추가, 미적용 Migration 참조

---

## 저장소 구조 요약

```
┌──────────────────────────────────────────────────────────┐
│                      Supabase (20 테이블)                  │
│                                                            │
│  ── 활성 (코드 사용) ──────────────────────────────────── │
│  │  sessions          │  clients           │  transcripts │
│  │  billable_units    │  delivery_profiles │  error_logs  │
│  │  export_jobs       │  client_sku_rules  │  funnel_events│
│  │                    │  sku_presets       │              │
│  ├─────────────────────────────────────────────────────── │
│  ── 레거시 (코드 미사용, Migration 001/002) ───────────── │
│  │  campaigns         │  peers             │  consents    │
│  │  campaign_matches  │  session_labels    │  labels      │
│  │  missions          │  share_batches     │  users_profile│
│  │  mission_progress  │  score_components  │              │
│  └─────────────────────────────────────────────────────── │
├──────────────────────────────────────────────────────────┤
│              localStorage (브라우저)                        │
│  uncounted_user_profile, uncounted_file_paths,            │
│  uncounted_group_rels, uncounted_sessions,                 │
│  uncounted_auto_scan, uncounted_auto_label, ...            │
├──────────────────────────────────────────────────────────┤
│              IndexedDB (브라우저)                           │
│  세션 캐시, 트랜스크립트, 자동라벨, 화자분리,             │
│  음소거 오디오, PII 감지 결과                              │
└──────────────────────────────────────────────────────────┘
```

---

## Supabase 테이블

### 1. sessions (핵심 세션 테이블)

| 컬럼명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `id` | TEXT | PK | 세션 고유 ID |
| `title` | TEXT | | 세션 제목 (마스킹 처리됨) |
| `date` | TEXT | | 세션 날짜 (YYYY-MM-DD) |
| `duration` | INTEGER | | 길이 (초) |
| `qa_score` | NUMERIC | | 품질 점수 (0~100, 레거시) |
| `contribution_score` | NUMERIC | | 기여도 (레거시) |
| `labels` | JSONB | | 사용자 라벨 (LabelCategory) |
| `strategy_locked` | BOOLEAN | | 전략 잠금 (레거시) |
| `asset_type` | TEXT | | 자산 유형 (레거시) |
| `is_public` | BOOLEAN | false | 공개 여부 (레거시, visibility_status으로 대체) |
| `visibility_status` | TEXT | 'PRIVATE' | 'PUBLIC_CONSENTED' \| 'PRIVATE' |
| `visibility_source` | TEXT | | 'GLOBAL_DEFAULT' \| 'MANUAL' \| 'SKU_DEFAULT' |
| `visibility_consent_version` | TEXT | NULL | 동의 버전 (e.g. 'v1-2026-02') |
| `visibility_changed_at` | TEXT | NULL | 변경일 (YYYY-MM-DD) |
| `status` | TEXT | 'uploaded' | 'pending' \| 'processing' \| 'uploading' \| 'uploaded' \| 'failed' |
| `is_pii_cleaned` | BOOLEAN | false | PII 정제 완료 |
| `chunk_count` | INTEGER | 0 | 1분 단위 청크 수 |
| `audio_url` | TEXT | NULL | 정제된 오디오 URL (Supabase Storage) |
| `call_record_id` | TEXT | NULL | 원본 통화 파일 ID |
| `upload_status` | TEXT | 'LOCAL' | 'LOCAL' \| 'QUEUED' \| 'UPLOADING' \| 'UPLOADED' \| 'FAILED' |
| `pii_status` | TEXT | 'CLEAR' | 'CLEAR' \| 'SUSPECT' \| 'LOCKED' \| 'REVIEWED' |
| `share_scope` | TEXT | 'PRIVATE' | 'PRIVATE' \| 'GROUP' \| 'PUBLIC' |
| `eligible_for_share` | BOOLEAN | false | 공유 적격 |
| `review_action` | TEXT | NULL | 'EXCLUDE_SEGMENT' \| 'MASK_TEXT_ONLY' \| 'DO_NOT_SHARE' |
| `lock_reason` | JSONB | NULL | PII 잠금 사유 메타데이터 |
| `lock_start_ms` | BIGINT | NULL | PII 잠금 구간 시작 (ms) |
| `lock_end_ms` | BIGINT | NULL | PII 잠금 구간 종료 (ms) |
| `local_sanitized_wav_path` | TEXT | NULL | 로컬 정제 WAV 경로 |
| `local_sanitized_text_preview` | TEXT | NULL | 정제 텍스트 미리보기 |
| `consent_status` | TEXT | 'locked' | 'locked' \| 'user_only' \| 'both_agreed' (통신비밀보호법) |
| `verified_speaker` | BOOLEAN | false | 화자 본인 인증 완료 |
| `user_id` | TEXT | NULL | 사용자 ID (Auth Phase 2) |
| `peer_id` | TEXT | NULL | 상대방 ID |
| `label_status` | TEXT | NULL | 'AUTO' \| 'RECOMMENDED' \| 'REVIEW' \| 'LOCKED' \| 'CONFIRMED' |
| `label_source` | TEXT | NULL | 'auto' \| 'user' \| 'user_confirmed' \| 'multi_confirmed' |
| `label_confidence` | NUMERIC | NULL | 라벨 신뢰도 (0~1) |
| `dup_status` | TEXT | 'none' | 'none' \| 'suspected' \| 'confirmed' |
| `dup_group_id` | TEXT | NULL | 중복 그룹 ID |
| `dup_confidence` | NUMERIC | NULL | 중복 유사도 (0~1) |
| `file_hash_sha256` | TEXT | NULL | 파일 해시 |
| `audio_fingerprint` | TEXT | NULL | 오디오 핑거프린트 |
| `dup_representative` | BOOLEAN | NULL | 그룹 대표 여부 |
| `pid` | TEXT | NULL | 레거시 (peers 연동용, 코드 미사용) |

**labels JSONB 구조:**
```json
{
  "relationship": "가족",
  "purpose": "일상",
  "domain": "생활",
  "tone": "보통",
  "noise": "조용",
  "primarySpeechAct": "진술",
  "speechActEvents": ["동의", "감사"],
  "interactionMode": "casual"
}
```

**인덱스 권장:**
- `idx_sessions_date` ON sessions(date)
- `idx_sessions_user_id` ON sessions(user_id)
- `idx_sessions_visibility` ON sessions(visibility_status)
- `idx_sessions_upload` ON sessions(upload_status)

---

### 2. billable_units (빌링 유닛 테이블)

| 컬럼명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `id` | TEXT | PK | 유닛 ID (session_id_minuteIndex 형식) |
| `session_id` | TEXT | | 원본 세션 ID |
| `minute_index` | INTEGER | | 분 단위 인덱스 (0-based) |
| `effective_seconds` | INTEGER | | 유효 초 (≤60) |
| `quality_grade` | TEXT | | 'A' \| 'B' \| 'C' |
| `qa_score` | NUMERIC | | 품질 점수 (0~100) |
| `quality_tier` | TEXT | | 'basic' \| 'verified' \| 'gold' |
| `label_source` | TEXT | NULL | 라벨 출처 |
| `has_labels` | BOOLEAN | | 라벨 보유 여부 |
| `consent_status` | TEXT | | 'PUBLIC_CONSENTED' \| 'PRIVATE' |
| `pii_status` | TEXT | | 'CLEAR' \| 'SUSPECT' \| 'LOCKED' \| 'REVIEWED' |
| `lock_status` | TEXT | 'available' | 'available' \| 'locked_for_job' \| 'delivered' |
| `locked_by_job_id` | TEXT | NULL | 잠금 처리한 작업 ID |
| `session_date` | TEXT | | 세션 날짜 (비정규화) |
| `user_id` | TEXT | NULL | 사용자 ID |
| `created_at` | TIMESTAMPTZ | now() | 생성일 (DB 자동) |

---

### 3. clients (납품처 테이블)

| 컬럼명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `id` | TEXT | PK | 납품처 ID |
| `name` | TEXT | | 회사/기관명 |
| `contact_name` | TEXT | NULL | 담당자명 |
| `contact_email` | TEXT | NULL | 담당자 이메일 |
| `notes` | TEXT | NULL | 내부 메모 |
| `is_active` | BOOLEAN | true | 활성 여부 |
| `created_at` | TIMESTAMP | now() | 생성일 |
| `updated_at` | TIMESTAMP | now() | 수정일 |

---

### 4. delivery_profiles (납품 프로필 테이블)

| 컬럼명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `id` | TEXT | PK | 프로필 ID |
| `client_id` | TEXT | | FK → clients.id |
| `name` | TEXT | | 프로필명 |
| `format` | TEXT | | 'json' \| 'jsonl' \| 'csv' \| 'audio_manifest' \| 'wav_bundle' |
| `fieldset` | TEXT[] | | 내보내기 필드 키 목록 |
| `channel_ko` | TEXT | | '직접 전달' \| 'API' \| '클라우드 공유' |
| `requires_pii_cleaned` | BOOLEAN | | PII 정제 필수 |
| `requires_consent_verified` | BOOLEAN | | 동의 검증 필수 |
| `min_quality_grade` | TEXT | NULL | 최소 품질: 'A' \| 'B' \| 'C' |
| `notes` | TEXT | NULL | 메모 |
| `created_at` | TIMESTAMP | now() | |
| `updated_at` | TIMESTAMP | now() | |

---

### 5. client_sku_rules (납품처별 SKU 규칙)

| 컬럼명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `id` | TEXT | PK | 규칙 ID |
| `client_id` | TEXT | | FK → clients.id |
| `sku_id` | TEXT | | SKU ID (U-A01 등) |
| `preset_id` | TEXT | NULL | FK → sku_presets.id |
| `component_ids` | TEXT[] | | 컴포넌트 ID 목록 |
| `max_units_month` | INTEGER | NULL | 월간 BU 한도 |
| `price_per_unit` | NUMERIC | NULL | ₩/BU 단가 |
| `discount_pct` | NUMERIC | 0 | 할인율 (0~100) |
| `is_active` | BOOLEAN | true | |
| `created_at` | TIMESTAMP | now() | |

---

### 6. sku_presets (SKU 프리셋 테이블)

| 컬럼명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `id` | TEXT | PK | |
| `name` | TEXT | | 프리셋명 |
| `base_sku_id` | TEXT | | 기반 SKU ID |
| `component_ids` | TEXT[] | | 컴포넌트 목록 |
| `require_audio` | BOOLEAN | | 오디오 필수 |
| `require_labels` | JSONB | | false \| true \| string[] (특정 필드명) |
| `label_value_filter` | JSONB | | { field: ["allowed_value1", ...] } |
| `require_consent` | BOOLEAN | | 동의 필수 |
| `require_pii_cleaned` | BOOLEAN | | PII 정제 필수 |
| `min_quality_grade` | TEXT | NULL | 최소 품질 |
| `domain_filter` | TEXT[] | | 도메인 제한 (빈 배열=전체) |
| `export_fields` | TEXT[] | | 내보내기 필드 |
| `preferred_format` | TEXT | | 'json' \| 'jsonl' \| 'csv' |
| `suggested_price_per_unit` | NUMERIC | NULL | 참고 단가 |
| `notes` | TEXT | NULL | |
| `is_active` | BOOLEAN | true | |
| `created_at` | TIMESTAMP | now() | |
| `updated_at` | TIMESTAMP | now() | |

---

### 7. export_jobs (내보내기 작업 테이블)

| 컬럼명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `id` | TEXT | PK | |
| `client_id` | TEXT | NULL | FK → clients.id (NULL=내부 사용) |
| `sku_id` | TEXT | | SKU ID |
| `component_ids` | TEXT[] | | 컴포넌트 목록 |
| `delivery_profile_id` | TEXT | NULL | FK → delivery_profiles.id |
| `requested_units` | INTEGER | | 요청 BU 수 |
| `actual_units` | INTEGER | 0 | 실제 추출 수 |
| `sampling_strategy` | TEXT | | 'all' \| 'random' \| 'quality_first' \| 'stratified' |
| `filters` | JSONB | | 필터 조건 (아래 구조) |
| `status` | TEXT | 'draft' | 'draft' \| 'queued' \| 'running' \| 'completed' \| 'failed' \| 'cancelled' |
| `selection_manifest` | TEXT[] | NULL | 선택된 BU ID 목록 |
| `output_format` | TEXT | | 출력 포맷 |
| `logs` | JSONB[] | | 작업 로그 [{timestamp, level, message}] |
| `error_message` | TEXT | NULL | 실패 사유 |
| `created_at` | TIMESTAMP | now() | |
| `started_at` | TIMESTAMP | NULL | |
| `completed_at` | TIMESTAMP | NULL | |

**filters JSONB 구조:**
```json
{
  "minQualityGrade": "B",
  "qualityTier": ["verified", "gold"],
  "labelSource": ["user", "user_confirmed"],
  "requireConsent": true,
  "requirePiiCleaned": true,
  "dateRange": { "from": "2026-01-01", "to": "2026-03-01" },
  "userIds": []
}
```

---

### 8. transcripts (STT 텍스트 테이블)

| 컬럼명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `session_id` | TEXT | PK (UNIQUE) | FK → sessions.id, upsert onConflict 키 |
| `user_id` | TEXT | | 사용자 ID (RLS/필터용) |
| `text` | TEXT | | 전체 전사 텍스트 |
| `summary` | TEXT | NULL | KoBART/Ollama 요약 (서버 STT 시 생성) |
| `words` | JSONB | NULL | [{word, start, end, probability}] 단어별 타임스탬프 (Whisper word_timestamps) |
| `created_at` | TIMESTAMPTZ | now() | 생성일 |

> **참고:** `source` ('device' \| 'server') 필드는 IndexedDB 로컬(`TranscriptEntry`)에만 저장되며, Supabase에는 미저장.

**words JSONB 구조 (TranscriptWord[]):**
```json
[
  { "word": "안녕하세요", "start": 0.0, "end": 0.8, "probability": 0.95 },
  { "word": "오늘", "start": 0.85, "end": 1.1, "probability": 0.92 }
]
```

**데이터 흐름:**
- **쓰기:** `transcriptStore.ts:backupToSupabase()` — session_id, user_id, text, words, created_at
- **읽기:** `transcriptStore.ts:restoreFromSupabase()` — session_id, text, summary, created_at, words (user_id로 필터)
- **Colab:** `colab/faster_whisper_batch.ipynb` — session_id, user_id, text, summary, words, created_at

---

### 9. error_logs (에러 로그)

| 컬럼명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `id` | TEXT | PK | UUID |
| `timestamp` | TIMESTAMPTZ | now() | 발생 시각 |
| `level` | TEXT | | 'error' \| 'warn' |
| `message` | TEXT | | 에러 메시지 (최대 500자) |
| `stack` | TEXT | NULL | 스택 트레이스 (최대 1000자) |
| `context` | TEXT | NULL | 발생 위치 (페이지/함수명, e.g. 'unhandledrejection') |
| `user_id` | TEXT | NULL | |
| `device_info` | TEXT | NULL | User-Agent 문자열 (최대 120자) |

**데이터 흐름:** `errorLogger.ts` — localStorage 큐 (`uncounted_error_log`, max 100건) → 온라인 시 Supabase upsert

---

### 10. funnel_events (퍼널 이벤트)

| 컬럼명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `id` | TEXT | PK | UUID |
| `step` | TEXT | | 퍼널 단계 (FunnelStep 타입, 아래 참조) |
| `timestamp` | TIMESTAMPTZ | now() | 발생 시각 |
| `date_bucket` | TEXT | | YYYY-MM-DD |
| `user_id` | TEXT | NULL | |
| `meta` | JSONB | NULL | 이벤트별 추가 데이터 |

**FunnelStep 값:**
`onboarding_start`, `onboarding_consent`, `onboarding_complete`, `scan_start`, `scan_complete`, `label_start`, `label_complete`, `consent_global_on`, `consent_global_off`, `consent_session_on`, `consent_session_off`, `upload_start`, `upload_complete`, `upload_fail`, `voice_enroll_start`, `voice_enroll_complete`, `peer_invite_sent`, `peer_invite_accepted`, `bulk_public`

**데이터 흐름:** `funnelLogger.ts` — localStorage 큐 (`uncounted_funnel_events`, max 500건) → 온라인 시 Supabase upsert

---

## localStorage 키 목록

### 사용자 프로필 & 설정

| 키 | 값 타입 | 용도 |
|----|---------|------|
| `uncounted_user_profile` | UserProfile JSON | 비PII 프로필 (로컬 전용, 서버 전송 없음) |
| `uncounted_pseudo_id` | string (UUID) | 익명 기기 식별자 |
| `uncounted_auto_scan` | 'on' \| 'off' | 자동 스캔 토글 |
| `uncounted_auto_label` | 'on' \| 'off' | 자동 라벨링 토글 |
| `uncounted_pii_auto_protect` | 'on' \| 'off' | PII 자동 보호 |

### 동의 & 권한

| 키 | 값 타입 | 용도 |
|----|---------|------|
| `uncounted_pipa_consent` | PipaConsentRecord JSON | PIPA 제15조/제17조 동의 기록 |
| `uncounted_metadata_consent` | MetadataConsentState JSON | SKU별 메타데이터 수집 동의 |
| `uncounted_sku_consents` | Record<SkuId, bool> | SKU별 참여 동의 |
| `uncounted_joined_skus` | string[] | 참여 SKU 목록 |
| `uncounted_admin_auth` | {verified: bool} | 관리자 인증 상태 |

### 파일 & 세션 관리

| 키 | 값 타입 | 용도 |
|----|---------|------|
| `uncounted_file_paths` | Record<sessionId, filePath> | 오디오 파일 경로 캐시 |
| `uncounted_sessions` | Session[] JSON | 세션 목록 캐시 (오프라인 대비) |
| `uncounted_visibility` | Record<sessionId, VisibilityOverride> | 공개 상태 오버라이드 |
| `uncounted_group_rels` | Record<contactName, relationship> | 연락처 그룹 관계 라벨 |

### 음성 생체인증 (Phase 2)

| 키 | 값 타입 | 용도 |
|----|---------|------|
| `uncounted_voice_profile` | VoiceProfile JSON | 음성 등록 임베딩 (256차원) |
| `uncounted_verification_cache` | VerificationResult[] | 화자 인증 결과 캐시 |

### 메타데이터 수집기

| 키 | 값 타입 | 대응 SKU |
|----|---------|----------|
| `uncounted_audio_hashes` | string[] (max 5000) | 중복 탐지 |
| `uncounted_audio_env_records` | AudioEnvironmentRecord[] | U-M06 |
| `uncounted_activity_state_records` | ActivityStateRecord[] | U-M11 |
| `uncounted_light_records` | AmbientLightRecord[] | U-M13 |
| `uncounted_battery_records` | BatteryChargingRecord[] | U-M09 |
| `uncounted_app_lifecycle_records` | AppLifecycleRecord[] | U-M16 |
| `uncounted_call_time_patterns` | CallTimePatternRecord[] | U-M07 |
| `uncounted_behavior_profiles` | BehaviorProfile[] | U-M03/M04 자기보고 |

### 캠페인 & 미션

| 키 | 값 타입 | 용도 |
|----|---------|------|
| `uncounted_consents` | ConsentLog[] | 캠페인 참여/탈퇴 이력 |
| `uncounted_mission_state` | {completedMissions, progress} | 미션 완료 추적 |
| `uncounted_label_trust` | Record<sessionId, TrustMetrics> | 라벨 신뢰도 |

---

## IndexedDB 저장소

| 스토어 | 키 | 값 | 용도 |
|--------|-----|-----|------|
| sessions | sessionId | Session 객체 | 세션 캐시 (빠른 로딩) |
| transcripts | sessionId | 전체 텍스트 | STT 결과 |
| auto_labels | sessionId | AutoLabelResult | 자동 라벨 결과 |
| diarization | sessionId | DiarizationResult | 화자 분리 결과 |
| muted_audio | sessionId | base64 오디오 | 상대방 음소거 오디오 |
| pii_cache | sessionId | PII 감지 결과 | PII 분석 캐시 |

---

## ER 다이어그램 (관계도)

```
sessions ──────< billable_units
    │                   │
    │                   │ (locked_by_job_id)
    │                   ▼
    │             export_jobs ──── clients
    │                              │
    │                              ├──< delivery_profiles
    │                              │
    │                              └──< client_sku_rules ──── sku_presets
    │
    ├──< transcripts
    │
    ├──< error_logs
    │
    └──< funnel_events
```

- sessions → billable_units: 1:N (1세션 = N분 유닛)
- clients → delivery_profiles: 1:N
- clients → client_sku_rules: 1:N
- client_sku_rules → sku_presets: N:1 (선택적)
- export_jobs → clients: N:1 (선택적, NULL=내부)
- export_jobs → billable_units: N:M (selection_manifest)

---

## 부록: 레거시 테이블 (코드 미사용)

> Migration 001/002에서 생성된 테이블. 현재 소스코드에서 참조하지 않음.
> FK 의존성이 있어 DROP하지 않고 유지 중 (sessions.peer_id → peers.id 등).

### campaigns (001 레거시 — 005의 campaigns와 구조 다름)
| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| `id` | TEXT | PK |
| `name` | TEXT | 캠페인명 |
| `description` | TEXT | 설명 |
| `bonus_label` | TEXT | 보너스 라벨 |
| `required_tier` | TEXT | 필요 등급 |
| `unit_price` | INTEGER | 단가 |
| `is_active` | BOOLEAN | 활성 여부 |
| `created_at` | TIMESTAMPTZ | 생성일 |

### campaign_matches (001 레거시)
| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| `id` | INTEGER | PK |
| `campaign_id` | TEXT | FK → campaigns.id |
| `session_id` | TEXT | FK → sessions.id |
| `matched_at` | TIMESTAMPTZ | 매칭일 |

### consents (001 레거시)
| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| `id` | INTEGER | PK |
| `user_id` | TEXT | 사용자 ID |
| `pid` | TEXT | 익명 ID |
| `campaign_id` | TEXT | FK → campaigns.id |
| `action` | TEXT | 동의 행위 |
| `consented_at` | TIMESTAMPTZ | 동의일 |

### labels (001 레거시)
| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| `id` | INTEGER | PK |
| `session_id` | TEXT | FK → sessions.id |
| `user_id` | TEXT | |
| `relationship` | TEXT | 관계 |
| `purpose` | TEXT | 용도 |
| `domain` | TEXT | 도메인 |
| `tone` | TEXT | 톤 |
| `noise` | TEXT | 소음 |
| `labeled_at` | TIMESTAMPTZ | 라벨일 |

### missions (001 레거시)
| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| `code` | TEXT | PK |
| `title` | TEXT | 미션명 |
| `description` | TEXT | 설명 |
| `target_value` | INTEGER | 목표값 |
| `reward` | TEXT | 보상 |

### mission_progress (001 레거시)
| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| `id` | INTEGER | PK |
| `user_id` | TEXT | |
| `pid` | TEXT | |
| `mission_code` | TEXT | FK → missions.code |
| `current_val` | INTEGER | 현재값 |
| `completed` | BOOLEAN | 완료 여부 |
| `completed_at` | TIMESTAMPTZ | 완료일 |
| `updated_at` | TIMESTAMPTZ | 수정일 |

### peers (002)
| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| `id` | TEXT | PK |
| `user_id` | TEXT | |
| `pid` | TEXT | |
| `phone_hash` | TEXT | 전화번호 해시 |
| `masked_phone` | TEXT | 마스킹 전화번호 |
| `display_name` | TEXT | 표시명 |
| `relationship` | TEXT | 관계 (default: UNKNOWN) |
| `rel_confidence` | NUMERIC | 관계 신뢰도 |
| `rel_source` | TEXT | 관계 출처 (default: INFERRED) |
| `domain` | TEXT | 도메인 (default: ETC) |
| `dom_confidence` | NUMERIC | 도메인 신뢰도 |
| `dom_source` | TEXT | 도메인 출처 (default: INFERRED) |
| `call_count` | INTEGER | 통화 횟수 |
| `total_duration` | INTEGER | 총 통화시간 |
| `latest_date` | TEXT | 최근 통화일 |
| `pii_flag` | BOOLEAN | PII 플래그 |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

### score_components (001 레거시)
| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| `id` | INTEGER | PK |
| `session_id` | TEXT | FK → sessions.id |
| `quality_factor` | NUMERIC | |
| `length_factor` | NUMERIC | |
| `label_factor` | NUMERIC | |
| `domain_factor` | NUMERIC | |
| `rarity_factor` | NUMERIC | |
| `base_units` | NUMERIC | |
| `composite` | NUMERIC | |
| `earning_low` | INTEGER | |
| `earning_mid` | INTEGER | |
| `earning_high` | INTEGER | |
| `algo_version` | TEXT | default: v1 |
| `calculated_at` | TIMESTAMPTZ | |

### session_labels (002)
| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| `id` | INTEGER | PK |
| `session_id` | TEXT | FK → sessions.id |
| `peer_id` | TEXT | FK → peers.id |
| `user_id` | TEXT | |
| `pid` | TEXT | |
| `relationship` | TEXT | |
| `rel_confidence` | NUMERIC | |
| `domain` | TEXT | |
| `dom_confidence` | NUMERIC | |
| `label_status` | TEXT | default: REVIEW |
| `applied_rules` | JSONB | |
| `pii_override` | BOOLEAN | |
| `user_override` | JSONB | |
| `rule_version` | TEXT | default: v1 |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

### share_batches (002)
| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| `id` | TEXT | PK |
| `user_id` | TEXT | |
| `pid` | TEXT | |
| `target_scope` | TEXT | |
| `total_sessions` | INTEGER | |
| `eligible_sessions` | INTEGER | |
| `locked_sessions` | INTEGER | |
| `status` | TEXT | default: RUNNING |
| `started_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ | |

### users_profile (001 레거시)
| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| `pid` | TEXT | PK |
| `user_id` | TEXT | |
| `age_band` | TEXT | |
| `gender` | TEXT | |
| `region_group` | TEXT | |
| `primary_language` | TEXT | |
| `speech_style` | TEXT | |
| `accent_group` | TEXT | |
| `common_env` | TEXT | |
| `common_device_mode` | TEXT | |
| `domain_mix` | TEXT[] | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

---

## 부록: 미적용 Migration (005/006)

> 아래 테이블은 migration SQL 파일에 정의되어 있으나 물리 DB에 미적용.
> 현재 소스코드에서도 사용하지 않으므로, 해당 기능 개발 시 적용 예정.

- **Migration 005** (`005_asset_ledger.sql`): user_asset_ledger, daily_asset_stats, monthly_asset_stats, campaigns(v2), campaign_progress
- **Migration 006** (`006_device_event_units.sql`): device_event_units, device_event_stats

---

## 설계 원칙

1. **GPU 추론값 저장 금지** — 스트레스/우울 등 AI 예측값 필드 없음
2. **정밀 데이터 금지** — 위치/정밀시간/앱명/텍스트 원문/연락처 미저장
3. **시간 버킷** — 모든 시간은 2h/6h 버킷 또는 YYYY-MM-DD (정밀 타임스탬프 없음)
4. **범위 기반 가치** — 단일 ₩ 값 대신 항상 (low, high, confirmed) 튜플
5. **로컬 우선** — 세션/프로필/설정은 localStorage/IDB 캐시, Supabase는 동기화용
6. **audioMetrics는 Supabase 미저장** — 로컬 분석 결과만 메모리/IDB에 보관