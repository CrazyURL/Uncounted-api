---
paths: src/lib/**
---

# 암호화 패턴 상세 + 인증 상세

## 미들웨어 체인

```
요청 → CORS → Logger → bodyDecryptMiddleware(/api/*) → authMiddleware(라우트별) → 핸들러
```

## 암호화 패턴

| 방향 | 형식 | 처리 |
|------|------|------|
| 요청 | `{ enc_data: "<base64url>" }` | `bodyDecryptMiddleware`가 자동 복호화 → `c.get('body')` |
| 응답 | `base64url(IV|AuthTag|Ciphertext)@enc_uncounted` | `encryptId()`로 민감 필드 암호화 후 반환 |

### crypto.ts 함수

- `encryptId(plaintext)` — raw 값 → `base64url(IV|AuthTag|Ciphertext)@enc_uncounted`
- `decryptId(encryptedId)` — `encryptId()` 역함수. suffix 없으면 throw. 외부 입력을 raw 토큰으로 복원할 때 사용.
- `decryptData(encData)` — 클라이언트 AES-GCM 바디 복호화 (suffix 없는 포맷)

## 인증

- **헤더**: `Authorization: Bearer {JWT}`
- **쿠키**: `uncounted_session` (httpOnly, SameSite=Lax, 1h) / `uncounted_refresh` (90d)
- `authMiddleware` — 필수 (401 반환)
- `optionalAuthMiddleware` — 선택적 (없어도 통과)
- 어드민: `app_metadata.role === 'admin'` 확인

## Signout 만료 토큰 처리

`/auth/signout`은 만료된 JWT에서도 `extractUserIdFromJwt(token)`으로 payload의 `sub`(userId)를 추출하여 `admin.signOut(userId)`를 호출한다.
이로써 access token 만료 상태에서 로그아웃해도 Supabase 세션(refresh token 포함)이 확실히 revoke된다.

## Refresh Token 흐름

Android 클라이언트는 로그인 응답에서 받은 `encryptId()` 값을 그대로 저장하고 `/auth/refresh` body에 전송한다.
쿠키(`uncounted_refresh`)는 `setAuthCookies()`가 raw Supabase 토큰을 직접 저장한다.

```
body.refresh_token  → encryptId 값 → decryptId() → raw Supabase 토큰 → Supabase
cookie refresh      → raw 토큰 그대로               → Supabase
```

**규칙**: body에서 받은 토큰만 `decryptId()` 필요. 쿠키 경로에는 절대 적용하지 말 것.

## 주요 코드 패턴

```typescript
// 라우트에서 body 읽기
const body = getBody<MyType>(c)

// ID 암호화 응답
return c.json({ id: encryptId(rawId), ... })

// body의 encryptId 토큰 복호화 (Android 클라이언트 전용)
const rawToken = decryptId(body.encrypted_token)  // throws if invalid

// 인증 필요한 라우트
sessions.use('/*', authMiddleware)

// 세션 타입 변환 (snake_case ↔ camelCase)
const session = sessionFromRow(dbRow)  // DB → API
const row = sessionToRow(input)        // API → DB
```
