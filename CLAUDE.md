# Uncounted API

Hono 기반 백엔드 REST API. Supabase Admin Client로 DB/Storage 접근, 클라이언트와 통신 시 AES-256-GCM 암호화 적용.

## Stack

- **Framework**: Hono 4.x + @hono/node-server
- **Database**: Supabase (service_role key, RLS bypass)
- **Encryption**: AES-256-GCM (요청 복호화 ↔ 응답 암호화)
- **Runtime**: Node.js + TypeScript (tsx)

## 환경변수

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
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
```

## 프로젝트 구조

```
src/
  index.ts          # 앱 진입점 (미들웨어 + 라우트 등록)
  dev.ts            # 개발 서버 (Node.js)
  types.ts          # Hono Context 타입 확장 (userId, body)
  lib/
    supabase.ts     # Supabase Admin 클라이언트
    crypto.ts       # encryptId() / decryptData()
    middleware.ts   # bodyDecrypt, authMiddleware, optionalAuthMiddleware
  routes/
    auth.ts         # /api/auth — 로그인/회원가입/OAuth/세션
    sessions.ts     # /api/sessions — 세션 CRUD
    storage.ts      # /api/storage — 오디오/메타 업로드
    transcripts.ts  # /api/transcripts — 트랜스크립트 관리
    logging.ts      # /api/logging — 퍼널/에러 로그
    admin.ts        # /api/admin — 어드민 전용 API
```

## 미들웨어 체인

```
요청 → CORS → Logger → bodyDecryptMiddleware(/api/*) → authMiddleware(라우트별) → 핸들러
```

## 암호화 패턴

| 방향 | 형식 | 처리 |
|------|------|------|
| 요청 | `{ enc_data: "<base64url>" }` | `bodyDecryptMiddleware`가 자동 복호화 → `c.get('body')` |
| 응답 | `base64url(IV\|AuthTag\|Ciphertext)@enc_uncounted` | `encryptId()`로 민감 필드 암호화 후 반환 |

## 인증

- **헤더**: `Authorization: Bearer {JWT}`
- **쿠키**: `uncounted_session` (httpOnly, SameSite=Lax)
- `authMiddleware` — 필수 (401 반환)
- `optionalAuthMiddleware` — 선택적 (없어도 통과)

## 주요 패턴

```typescript
// 라우트에서 body 읽기
const body = getBody<MyType>(c)

// ID 암호화 응답
return c.json({ id: encryptId(rawId), ... })

// 인증 필요한 라우트
sessions.use('/*', authMiddleware)
```
