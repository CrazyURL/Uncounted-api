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

## 인증

- **헤더**: `Authorization: Bearer {JWT}`
- **쿠키**: `uncounted_session` (httpOnly, SameSite=Lax, 1h) / `uncounted_refresh` (90d)
- `authMiddleware` — 필수 (401 반환)
- `optionalAuthMiddleware` — 선택적 (없어도 통과)
- 어드민: `app_metadata.role === 'admin'` 확인

## 주요 코드 패턴

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
