# 백엔드 API 구조

## 📍 개요

Supabase 직접 호출 로직을 **Hono 기반 백엔드 API**로 분리. 모든 요청/응답은 **AES-256-GCM** 암호화로 보호됩니다.

## 📁 프로젝트 구조

```
uncounted-api/
├── src/
│   ├── index.ts          # 앱 진입점 (미들웨어 + 라우트)
│   ├── dev.ts            # 개발 서버
│   ├── types.ts          # Hono Context 타입 확장
│   ├── lib/
│   │   ├── supabase.ts   # Admin 클라이언트
│   │   ├── crypto.ts     # AES-256-GCM 암호화/복호화
│   │   └── middleware.ts # 인증 + 바디 복호화 미들웨어
│   └── routes/
│       ├── auth.ts       # 인증 API
│       ├── sessions.ts   # 세션 CRUD
│       ├── storage.ts    # 스토리지 업로드/삭제
│       ├── transcripts.ts# 트랜스크립트 관리
│       ├── logging.ts    # 퍼널/에러 로깅
│       └── admin.ts      # 어드민 API
├── .env.example
├── tsconfig.json
└── package.json
```

## 🔐 암호화 시스템

### 요청 암호화
클라이언트가 민감한 요청 바디를 암호화하여 전송:
```json
{ "enc_data": "<base64url(IV|AuthTag|Ciphertext)>" }
```
서버의 `bodyDecryptMiddleware`가 자동으로 복호화 → `c.get('body')`에 저장.

### 응답 암호화
민감 필드(ID, URL 등)를 `encryptId()`로 암호화하여 반환:
```
"<base64url(IV|AuthTag|Ciphertext)>@enc_uncounted"
```

### 키 설정
```bash
# .env
ENCRYPTION_KEY=<32-byte hex>

# 키 생성
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 🔑 인증

모든 `/api/*` 엔드포인트는 Supabase JWT 인증 필요:

```
Authorization: Bearer {access_token}
# 또는
Cookie: uncounted_session={token}
```

- **httpOnly 쿠키**: 로그인 시 자동 설정 (1시간 만료)
- **리프레시 토큰 쿠키**: 90일 만료

## 🚀 환경변수

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
PORT=3001
CORS_ORIGIN=http://localhost:5173
ENCRYPTION_KEY=your-32-byte-hex-key
```

## 🔌 API 엔드포인트

### Root

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/` | 서비스 정보 (이름, 버전, 상태) |
| GET | `/health` | 헬스 체크 |
| GET | `/docs` | Swagger UI 문서 |
| GET | `/openapi.json` | OpenAPI 스펙 |

### Auth API `/api/auth`

| Method | Endpoint | 인증 | 설명 |
|--------|----------|------|------|
| POST | `/signin` | - | 이메일/비밀번호 로그인 (쿠키 설정) |
| POST | `/signup` | - | 회원가입 |
| POST | `/signout` | 필수 | 로그아웃 (쿠키 삭제) |
| GET | `/session` | 필수 | 현재 세션 정보 |
| GET | `/me` | 필수 | 인증된 사용자 정보 |
| POST | `/refresh` | - | 액세스 토큰 갱신 |
| POST | `/session` | - | OAuth 콜백 처리 (쿠키 설정) |
| GET | `/oauth/google` | - | Google OAuth 시작 (PKCE) |
| GET | `/oauth/callback` | - | OAuth 콜백 코드 수신 → 토큰 교환 |
| POST | `/link-pid` | 선택 | 가명 ID ↔ 사용자 연결 |

### Sessions API `/api/sessions`

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/` | 세션 목록 조회 (페이징) |
| GET | `/:id` | 세션 상세 조회 |
| POST | `/batch` | 세션 배치 저장 (최대 500건) |
| PUT | `/:id/labels` | 라벨 업데이트 |
| PUT | `/:id/visibility` | 공개 상태 업데이트 |
| DELETE | `/:id` | 세션 삭제 |

### Storage API `/api/storage`

| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/audio` | 정제된 오디오(WAV) 업로드 |
| POST | `/meta` | 메타 JSONL 업로드 |
| POST | `/audio/signed-url` | 재생용 Signed URL 발급 |
| DELETE | `/user` | 사용자 파일 전체 삭제 |

### Transcripts API `/api/transcripts`

| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/:sessionId` | 트랜스크립트 저장/수정 |
| GET | `/:sessionId` | 특정 트랜스크립트 조회 |
| GET | `/` | 전체 트랜스크립트 목록 |
| DELETE | `/:sessionId` | 트랜스크립트 삭제 |

### Logging API `/api/logging`

| Method | Endpoint | 인증 | 설명 |
|--------|----------|------|------|
| POST | `/funnel` | 선택 | 퍼널 이벤트 배치 업로드 |
| POST | `/errors` | 선택 | 에러 로그 배치 업로드 |

### Admin API `/api/admin`

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET/POST/DELETE | `/clients` | 클라이언트 관리 |
| GET/POST/DELETE | `/delivery-profiles` | 납품 프로필 관리 |
| GET/POST/DELETE | `/client-sku-rules` | 클라이언트 SKU 규칙 관리 (`clientId` 필수) |
| GET/POST/DELETE | `/sku-presets` | SKU 프리셋 관리 |
| GET/POST | `/export-jobs` | 내보내기 작업 목록/생성 |
| GET | `/export-jobs/:id` | 내보내기 작업 상세 조회 |
| DELETE | `/export-jobs/:id` | 내보내기 작업 삭제 |
| POST | `/export-jobs/:id/logs` | 작업 로그 추가 |
| GET/POST | `/billable-units` | 청구 단위 조회/배치 저장 |
| POST | `/billable-units/lock` | 단위 잠금 |
| POST | `/billable-units/unlock` | 잠금 해제 |
| POST | `/billable-units/mark-delivered` | 납품 완료 처리 |
| GET/POST | `/ledger-entries` | 원장 항목 조회/배치 upsert |
| POST | `/ledger-entries/update-status` | 원장 항목 상태 업데이트 (confirmed/withdrawable/paid) |
| POST | `/ledger-entries/confirm-job` | 작업 확정 및 지급 분배 |
| GET/POST | `/delivery-records` | 납품 기록 조회/배치 생성 (`clientId` 필수) |
| GET | `/sessions` | 전체 세션 조회 (어드민) |
| GET | `/transcripts` | 전체 트랜스크립트 조회 (어드민) |
| DELETE | `/reset-all` | 전체 데이터 초기화 ⚠️ |

## 🛠️ 기술 스택

- **Hono** — 경량 웹 프레임워크 (Edge 지원)
- **TypeScript** — 타입 안전성
- **Supabase JS Client** — DB/Storage/Auth
- **Node.js crypto** — AES-256-GCM 암호화
- **tsx** — TypeScript 실행 (개발)

## 🌐 개발 실행

```bash
# 개발 서버 (핫 리로드)
npm run dev

# 프로덕션 빌드
npm run build
npm start

# 헬스 체크
curl http://localhost:3001/health

# Swagger UI
open http://localhost:3001/docs
```
