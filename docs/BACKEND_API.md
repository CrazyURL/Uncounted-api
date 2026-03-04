# 백엔드 API 구조

## 📍 개요

Supabase 직접 호출 로직을 **Hono 기반 백엔드 API**로 분리하여, 클라이언트와 서버의 관심사를 명확히 분리했습니다.

## 🎯 분리 이유

### Before (문제점)
- ❌ 클라이언트 코드에 Supabase 로직 산재 (`sessionMapper`, `auth`, `storageUpload`)
- ❌ `SUPABASE_SERVICE_ROLE_KEY`가 클라이언트 번들에 포함될 위험
- ❌ RLS 우회 로직이 클라이언트에 노출
- ❌ 관리 복잡도 증가 (여러 파일에서 supabase 직접 호출)

### After (해결)
- ✅ 백엔드 API가 Supabase와 통신 (service_role 키 안전)
- ✅ 클라이언트는 REST API만 호출 (단일 책임)
- ✅ 타입 안전성 유지 (TypeScript 타입 공유)
- ✅ 배포 독립성 (프론트엔드/백엔드 분리 배포 가능)

## 📁 프로젝트 구조

```
uncounted-app/
├── src/                       # 클라이언트 (기존)
│   ├── pages/
│   ├── components/
│   ├── lib/
│   │   └── api/              # 🆕 백엔드 API 호출 레이어
│   │       ├── client.ts     # fetch 래퍼
│   │       ├── sessions.ts   # Sessions API
│   │       └── storage.ts    # Storage API
│   └── types/                # TypeScript 타입 (공유)
│
├── server/                   # 🆕 백엔드 API (Hono)
│   ├── index.ts             # 진입점
│   ├── dev.ts               # 개발 서버
│   ├── routes/
│   │   ├── sessions.ts      # Sessions CRUD
│   │   └── storage.ts       # Storage 업로드/삭제
│   ├── lib/
│   │   ├── supabase.ts      # Admin 클라이언트
│   │   └── middleware.ts    # 인증 미들웨어
│   └── README.md            # API 문서
│
├── .env.example             # 환경변수 템플릿
├── tsconfig.server.json     # 서버 전용 TS 설정
└── package.json             # 통합 빌드 스크립트
```

## 🚀 사용법

### 1. 환경변수 설정

```bash
# .env 파일에 추가
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
PORT=3001
CORS_ORIGIN=http://localhost:5173
VITE_API_URL=http://localhost:3001
```

### 2. 개발 서버 실행

```bash
# 백엔드만 실행
npm run dev:server

# 프론트엔드 + 백엔드 동시 실행
npm run dev:all
```

### 3. API 사용 (클라이언트)

```typescript
// src/lib/api/sessions.ts
import { fetchSessions, saveSessions } from './api/sessions'

// 세션 목록 조회
const { data, error } = await fetchSessions()

// 세션 배치 저장
const { data, error } = await saveSessions([session1, session2])
```

## 🔌 API 엔드포인트

### Sessions API

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/sessions` | 세션 목록 조회 (페이징) |
| GET | `/api/sessions/:id` | 세션 상세 조회 |
| POST | `/api/sessions/batch` | 세션 배치 저장 (최대 500건) |
| PUT | `/api/sessions/:id/labels` | 라벨 업데이트 |
| PUT | `/api/sessions/:id/visibility` | 공개 상태 업데이트 |
| DELETE | `/api/sessions/:id` | 세션 삭제 |

### Storage API

| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/api/storage/audio` | 정제된 오디오 업로드 |
| POST | `/api/storage/meta` | 메타 JSONL 업로드 |
| POST | `/api/storage/audio/signed-url` | Signed URL 발급 |
| DELETE | `/api/storage/user` | 사용자 파일 전체 삭제 |

## 🔐 인증

모든 API는 Supabase JWT 인증이 필요합니다:

```typescript
// 클라이언트에서 자동 처리
import { apiFetch } from './lib/api/client'

// getAccessToken()으로 토큰 자동 주입
const response = await apiFetch('/api/sessions')
```

## 🌐 배포

### Cloudflare Workers (추천)

```bash
npm install -g wrangler
wrangler init
wrangler deploy
```

무료 티어: 월 10만 요청

### Vercel Edge Functions

```bash
npm install -g vercel
vercel
```

`vercel.json`:
```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/server/index" }
  ]
}
```

### Railway / Render

Docker 배포 또는 Node.js 직접 실행

```bash
npm run build:server
node dist/server/dev.js
```

## 📝 다음 단계

### 클라이언트 마이그레이션 (점진적)

1. ✅ **백엔드 API 구축 완료**
2. ⏳ 클라이언트 코드 마이그레이션:
   - `src/lib/sessionMapper.ts` → `src/lib/api/sessions.ts` 사용
   - `src/lib/storageUpload.ts` → `src/lib/api/storage.ts` 사용
3. ⏳ 기존 Supabase 직접 호출 제거
4. ⏳ 프로덕션 배포

### 점진적 마이그레이션 전략

```typescript
// Before (Supabase 직접 호출)
import { supabase } from './supabase'
const { data } = await supabase.from('sessions').select('*')

// After (백엔드 API 호출)
import { fetchSessions } from './api/sessions'
const { data } = await fetchSessions()
```

## 🛠️ 기술 스택

- **Hono** - 경량 웹 프레임워크 (Edge 지원)
- **TypeScript** - 타입 안전성
- **Supabase JS Client** - DB/Storage/Auth
- **tsx** - TypeScript 실행
- **concurrently** - 병렬 개발 서버

## 📚 참고 문서

- [Hono 공식 문서](https://hono.dev/)
- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [server/README.md](./server/README.md) - API 상세 문서
