# Uncounted API

Hono 기반 백엔드 REST API. Supabase Admin Client로 DB 접근, iwinv S3 호환 스토리지로 파일 관리, 클라이언트와 통신 시 AES-256-GCM 암호화 적용.

## Stack

- **Framework**: Hono 4.x + @hono/node-server
- **Database**: Supabase (service_role key, RLS bypass)
- **Storage**: iwinv S3 호환 스토리지 (@aws-sdk/client-s3 + @aws-sdk/s3-request-presigner)
- **Encryption**: AES-256-GCM (요청 복호화 ↔ 응답 암호화)
- **Runtime**: Node.js + TypeScript (tsx)
- **Test**: Vitest 3.x

## 환경변수

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_AUDIO_BUCKET`, `S3_META_BUCKET`, `PORT`, `CORS_ORIGIN`, `ENCRYPTION_KEY`

## 개발

```bash
npm run dev    # tsx watch (핫 리로드)
npm run build  # tsc 컴파일
npm start      # dist/ 실행
npx vitest run # 테스트 실행
```

## 프로젝트 구조

```
src/
  index.ts / dev.ts / openapi.ts / types.ts
  lib/       # supabase.ts, s3.ts, crypto.ts, middleware.ts
  lib/audio/ # ffmpegProcessor.ts (WAV 전처리)
  lib/export/ # poolingService, packageBuilder, metadataRepository 등
  routes/    # auth, sessions, sessionChunks, storage, transcripts,
             # transcriptChunks, user, logging, admin, admin-exports,
             # admin-ledger, admin-utterances, upload
  scripts/   # 일회성 스크립트
supabase/
  migrations/  # 001~034 SQL 파일
```

## 핵심 패턴

- **요청**: `{ enc_data: "<base64url>" }` → `bodyDecryptMiddleware` 자동 복호화 → `c.get('body')`
- **응답**: `encryptId(rawId)` → `base64url(IV|AuthTag|Ciphertext)@enc_uncounted`
- **인증**: `authMiddleware` (필수) / `optionalAuthMiddleware` (선택) / 어드민: `app_metadata.role === 'admin'`
- **미들웨어 체인**: CORS → Logger → bodyDecrypt → authMiddleware → 핸들러

## Rules 참조

| 파일 | 내용 | 적용 경로 |
|------|------|----------|
| `.claude/rules/endpoints.md` | API 엔드포인트 전체 테이블 | `src/routes/**` |
| `.claude/rules/auth-encryption.md` | 암호화·인증 상세 + 코드 패턴 | `src/lib/**` |
| `.claude/rules/database.md` | DB 마이그레이션 규칙 | `supabase/**` |

## 품질 지표 B-60 고착 버그 — 2026-05-23

> **API는 버그의 원인이 아니다.** API의 `aggregateClientMetrics()`는 `utterances`에 이미 저장된
> `quality_score/quality_grade` 값을 정상적으로 읽었을 뿐이다.
> 버그 원인은 `uncounted-voice-api/app/worker.py`에 있다.

**기존 DB 값 신뢰 보류**:
- `utterances.quality_score = 60`, `quality_grade = B`, `snr_db = 0`, `speech_ratio = 1.0`
- 이 값은 실측이 아닌 fallback 기본값이다.
- 2026-05-23 worker 수정 후 신규 체리분부터 실측값이 저장된다.

**납품 리포트 / 품질 판단 주의**:
- 기존 B-60 값을 `quality_grade=B ✅`로 표시하지 말 것.
- `"품질 측정 버그 영향 가능 — 신뢰 보류 / 재측정 필요"`로 표시.
- `snr_db_avg=0` 원인을 librosa 이슈로 쓰지 말 것.
  librosa는 F0 분석 문제이고, SNR/B-60 고착은 `ffprobe -af` 측정 버그다.
- **API 쪽 납품 가능 여부 판단에서 기존 `quality_score/quality_grade`는 신뢰 보류.**
  `voice-api 수정 후 재측정된 값만 품질 판단에 사용한다.`

**기존 데이터 재처리 우선순위** (별도 dry-run/backfill 트랙):
1. `session_dataset_eligible=true` + `approved` 세션
2. export ZIP 생성 이력 있는 세션
3. utterance WAV가 S3에 존재하는 세션

**금지**:
- 기존 utterances / bu_quality_metrics 일괄 수정 금지
- dry-run 없이 overwrite 금지
