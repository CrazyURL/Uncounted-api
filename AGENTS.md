# Uncounted API

Hono 기반 백엔드 REST API. Supabase Admin Client로 DB 접근, iwinv S3 호환 스토리지로 파일 관리, 클라이언트와 통신 시 AES-256-GCM 암호화 적용.

## Stack

- **Framework**: Hono 4.x + @hono/node-server
- **Database**: Supabase (service_role key, RLS bypass)
- **Storage**: iwinv S3 호환 스토리지 (@aws-sdk/client-s3 + @aws-sdk/s3-request-presigner)
- **Encryption**: AES-256-GCM (요청 복호화 ↔ 응답 암호화)
- **Runtime**: Node.js + TypeScript (tsx)
- **Test**: Vitest 3.x
- **Docs**: Swagger UI (`/docs`) + OpenAPI JSON (`/openapi.json`)
- **Deploy**: Render.com (dev/prod 분리)

## 환경변수

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
S3_ENDPOINT=https://kr.object.iwinv.kr
S3_REGION=kr-standard
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_AUDIO_BUCKET=audio.your-domain.com
S3_META_BUCKET=meta.your-domain.com
PORT=3001
CORS_ORIGIN=http://localhost:5173
ENCRYPTION_KEY=<32-byte hex>
```

키 생성: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

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
  index.ts              # 앱 진입점 (미들웨어 + 라우트 등록)
  dev.ts                # 개발 서버 (Node.js)
  openapi.ts            # OpenAPI 3.0 스펙 (Swagger UI 제공)
  types.ts              # Hono Context 타입 확장 (userId, body)
  lib/
    supabase.ts         # Supabase Admin 클라이언트 (DB 전용)
    s3.ts               # S3 호환 스토리지 클라이언트 (iwinv)
    crypto.ts           # encryptId() / decryptData()
    middleware.ts       # bodyDecrypt, authMiddleware, optionalAuthMiddleware
  routes/
    auth.ts             # /api/auth — 로그인/회원가입/OAuth/세션
    sessions.ts         # /api/sessions — 세션 CRUD
    sessions-helpers.ts # sessionFromRow / sessionToRow 변환 헬퍼
    sessionChunks.ts    # /api/session-chunks — 청크별 라벨 업데이트
    storage.ts          # /api/storage — 오디오/메타 업로드
    transcripts.ts      # /api/transcripts — 트랜스크립트 관리
    transcriptChunks.ts # /api/transcript-chunks — 청크별 전사+오디오 통계
    user.ts             # /api/user — 사용자 동의 관리
    logging.ts          # /api/logging — 퍼널/에러 로그
    admin.ts            # /api/admin — 어드민 전용 API
supabase/
  migrations/           # DB 마이그레이션 (001~017)
config/
  client_secret_*.json  # Google OAuth 크리덴셜
```

## 미들웨어 체인

```
요청 → CORS → Logger → bodyDecryptMiddleware(/api/*) → authMiddleware(라우트별) → 핸들러
```

## 코딩 규칙

- **불변성**: 객체를 직접 수정하지 말고, 스프레드 연산자로 새 객체를 생성할 것
- **파일 크기**: 800줄 이하 유지, 함수는 50줄 이하
- **에러 처리**: try/catch로 모든 에러를 처리하고, 사용자 친화적 메시지 반환
- **입력 검증**: 시스템 경계에서 반드시 검증 (zod 등)
- **시크릿**: 절대 하드코딩하지 말 것. 항상 `process.env` 사용
- **수술적 변경**: 요청된 변경만 수행. 인접 코드 "개선" 금지
- **커밋 포맷**: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci)

## 암호화 패턴

| 방향 | 형식 | 처리 |
|------|------|------|
| 요청 | `{ enc_data: "<base64url>" }` | `bodyDecryptMiddleware`가 자동 복호화 → `c.get('body')` |
| 응답 | `base64url(IV\|AuthTag\|Ciphertext)@enc_uncounted` | `encryptId()`로 민감 필드 암호화 후 반환 |

## 인증

- **헤더**: `Authorization: Bearer {JWT}`
- **쿠키**: `uncounted_session` (httpOnly, SameSite=Lax, 1h) / `uncounted_refresh` (90d)
- `authMiddleware` — 필수 (401 반환)
- `optionalAuthMiddleware` — 선택적 (없어도 통과)
- 어드민: `app_metadata.role === 'admin'` 확인

## 주요 패턴

```typescript
// 라우트에서 body 읽기
const body = getBody<MyType>(c)

// ID 암호화 응답
return c.json({ id: encryptId(rawId), ... })

// 인증 필요한 라우트
sessions.use('/*', authMiddleware)

// 세션 타입 변환 (snake_case ↔ camelCase)
const session = sessionFromRow(dbRow)  // DB → API
const row = sessionToRow(input)        // API → DB
```

## API 엔드포인트 요약

| 그룹 | 경로 | 메서드 | 인증 | 설명 |
|------|------|--------|------|------|
| **Health** | `/` | GET | - | 서비스 상태 |
| | `/health` | GET | - | 헬스 체크 |
| **Auth** | `/api/auth/signin` | POST | - | 이메일/비밀번호 로그인 |
| | `/api/auth/signup` | POST | - | 회원가입 |
| | `/api/auth/signout` | POST | - | 로그아웃 |
| | `/api/auth/session` | GET/POST | - | 세션 조회/OAuth 토큰 저장 |
| | `/api/auth/me` | GET | 필수 | 현재 사용자 조회 |
| | `/api/auth/refresh` | POST | - | 토큰 갱신 |
| | `/api/auth/oauth/google` | GET | - | Google OAuth 시작 |
| | `/api/auth/oauth/callback` | GET | - | Google OAuth 콜백 |
| | `/api/auth/link-pid` | POST | 필수 | Pseudo ID 연결 |
| **Sessions** | `/api/sessions` | GET | 필수 | 세션 목록 (페이지네이션) |
| | `/api/sessions/batch` | POST | 필수 | 세션 일괄 upsert (최대 500건) |
| | `/api/sessions/:id` | GET/PATCH/DELETE | 필수 | 세션 상세/수정/삭제 |
| | `/api/sessions/:id/labels` | PUT | 필수 | 세션 레이블 수정 |
| | `/api/sessions/:id/label-status` | PUT | 필수 | 레이블 상태 수정 |
| | `/api/sessions/:id/visibility` | PUT | 필수 | 공개 여부 수정 |
| | `/api/sessions/:id/diarization` | PATCH | 필수 | 화자분리 상태 수정 |
| | `/api/sessions/:id/dup` | PATCH | 필수 | 중복 상태 수정 |
| **Session Chunks** | `/api/session-chunks/:sessionId/:chunkIndex/labels` | PUT | 필수 | 청크 라벨 업데이트 |
| **Storage** | `/api/storage/audio` | POST | 필수 | WAV 업로드 (base64) |
| | `/api/storage/meta` | POST | 필수 | 메타데이터 JSONL 업로드 |
| | `/api/storage/audio/chunk` | POST | 필수 | WAV 청크 업로드 (multipart) |
| | `/api/storage/audio/chunks/:sessionId` | GET | 필수 | 청크 목록 조회 |
| | `/api/storage/audio/signed-url` | POST | 필수 | 서명 URL 발급 |
| | `/api/storage/user` | DELETE | 필수 | 사용자 파일 전체 삭제 |
| **User** | `/api/user/consent` | GET/PUT | 필수 | 동의 상태 조회/수정 |
| **Transcripts** | `/api/transcripts` | GET | 필수 | 전사 목록 |
| | `/api/transcripts/:sessionId` | GET/POST/DELETE | 필수 | 전사 조회/저장/삭제 |
| **Transcript Chunks** | `/api/transcript-chunks` | POST | 필수 | 청크별 전사+오디오 통계 저장 |
| **Logging** | `/api/logging/funnel` | POST | - | 퍼널 이벤트 배치 |
| | `/api/logging/errors` | POST | - | 에러 로그 배치 |
| **Admin** | `/api/admin/me` | GET | 어드민 | 어드민 본인 확인 |
| | `/api/admin/sessions` | GET | 어드민 | 전체 세션 조회 (필터 지원) |
| | `/api/admin/users/stats` | GET | 어드민 | 사용자별 통계 |
| | `/api/admin/transcripts` | GET | 어드민 | 전체 전사 조회 |
| | `/api/admin/transcript-ids` | GET | 어드민 | 전사 보유 세션 ID 목록 |
| | `/api/admin/transcripts/bulk` | POST | 어드민 | 전사 일괄 조회 |
| | `/api/admin/clients` | GET/POST | 어드민 | 클라이언트 관리 |
| | `/api/admin/clients/:id` | DELETE | 어드민 | 클라이언트 삭제 |
| | `/api/admin/delivery-profiles` | GET/POST | 어드민 | 배송 프로필 관리 |
| | `/api/admin/delivery-profiles/:id` | DELETE | 어드민 | 배송 프로필 삭제 |
| | `/api/admin/client-sku-rules` | GET/POST | 어드민 | SKU 규칙 관리 |
| | `/api/admin/client-sku-rules/:id` | DELETE | 어드민 | SKU 규칙 삭제 |
| | `/api/admin/sku-presets` | GET/POST | 어드민 | SKU 프리셋 관리 |
| | `/api/admin/sku-presets/:id` | DELETE | 어드민 | SKU 프리셋 삭제 |
| | `/api/admin/export-jobs` | GET/POST | 어드민 | 익스포트 작업 관리 |
| | `/api/admin/export-jobs/:id` | GET/DELETE | 어드민 | 익스포트 작업 상세/삭제 |
| | `/api/admin/export-jobs/:id/logs` | POST | 어드민 | 작업 로그 추가 |
| | `/api/admin/billable-units` | GET/POST | 어드민 | 청구 단위 관리 |
| | `/api/admin/billable-units/lock` | POST | 어드민 | 청구 단위 잠금 |
| | `/api/admin/billable-units/unlock` | POST | 어드민 | 청구 단위 잠금 해제 |
| | `/api/admin/billable-units/mark-delivered` | POST | 어드민 | 납품 완료 처리 |
| | `/api/admin/ledger-entries` | GET/POST | 어드민 | 원장 항목 관리 |
| | `/api/admin/ledger-entries/update-status` | POST | 어드민 | 원장 상태 일괄 변경 |
| | `/api/admin/ledger-entries/confirm-job` | POST | 어드민 | 익스포트 작업 정산 확정 |
| | `/api/admin/delivery-records` | GET/POST | 어드민 | 납품 기록 관리 |
| | `/api/admin/storage/wavs` | GET | 어드민 | 전체 WAV 파일 목록 |
| | `/api/admin/storage/signed-url` | POST | 어드민 | 서명 URL 발급 |
| | `/api/admin/session-chunks/batch-signed-urls` | POST | 어드민 | 청크 일괄 서명 URL |
| | `/api/admin/sync-audio-urls` | POST | 어드민 | 오디오 URL 동기화 |
| | `/api/admin/reset-all` | DELETE | 어드민 | 전체 데이터 초기화 |

## DB 마이그레이션

`supabase/migrations/` 디렉토리에 001~017번까지의 SQL 마이그레이션 파일.
새 마이그레이션 추가 시 번호를 순차적으로 증가 (예: `018_xxx.sql`).
