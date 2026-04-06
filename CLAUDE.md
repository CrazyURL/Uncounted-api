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
             # admin-ledger, upload
  scripts/   # 일회성 마이그레이션 스크립트
supabase/
  migrations/  # 001~024 SQL 파일
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
