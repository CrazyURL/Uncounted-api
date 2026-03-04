# Uncounted Backend API

Hono 기반 백엔드 API — Supabase 로직 분리

## 🚀 시작하기

### 1. 환경변수 설정

`.env` 파일을 프로젝트 루트에 생성:

```bash
cp .env.example .env
```

필수 환경변수:
- `SUPABASE_URL` - Supabase 프로젝트 URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service Role 키 (RLS 우회)
- `PORT` - 서버 포트 (기본: 3001)
- `CORS_ORIGIN` - CORS 허용 origin

### 2. 개발 서버 실행

```bash
npm install
npm run dev
```

### 3. 빌드

```bash
npm run build
```

빌드 결과물: `dist/`

## 📁 구조

```
src/
├── index.ts              # Hono 앱 진입점
├── dev.ts                # 개발 서버
├── types.ts              # Hono Context 타입 확장
├── routes/
│   ├── auth.ts           # 인증 API
│   ├── sessions.ts       # 세션 CRUD API
│   ├── storage.ts        # Storage 업로드/삭제 API
│   ├── admin.ts          # 관리자 API
│   ├── logging.ts        # 퍼널/에러 로그 API
│   └── transcripts.ts    # 전사 데이터 API
└── lib/
    ├── supabase.ts       # Admin 클라이언트
    └── middleware.ts     # 인증 미들웨어
```

## 🔌 API 엔드포인트

### Auth
| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/api/auth/signin` | 이메일/비밀번호 로그인 |
| POST | `/api/auth/signup` | 회원가입 |
| POST | `/api/auth/signout` | 로그아웃 |
| GET | `/api/auth/session` | 세션 정보 조회 |
| POST | `/api/auth/refresh` | 토큰 갱신 |

### Sessions
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/sessions` | 세션 목록 조회 (페이징) |
| GET | `/api/sessions/:id` | 세션 상세 조회 |
| POST | `/api/sessions/batch` | 세션 배치 저장 (최대 500건) |
| PUT | `/api/sessions/:id/labels` | 라벨 업데이트 |
| PUT | `/api/sessions/:id/visibility` | 공개 상태 업데이트 |
| DELETE | `/api/sessions/:id` | 세션 삭제 |

### Storage
| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/api/storage/audio` | 정제된 오디오 업로드 |
| POST | `/api/storage/meta` | 메타 JSONL 업로드 |
| POST | `/api/storage/audio/signed-url` | Signed URL 발급 |
| DELETE | `/api/storage/user` | 사용자 파일 전체 삭제 |

## 🔐 인증

모든 API는 Supabase JWT 토큰 인증이 필요합니다.

요청 헤더:
```
Authorization: Bearer {JWT_TOKEN}
```

## 로컬 테스트

```bash
curl http://localhost:3001/health
```
