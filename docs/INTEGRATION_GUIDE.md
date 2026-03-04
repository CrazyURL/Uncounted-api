# 백엔드 API 통합 가이드

## ✅ 완료된 작업

### 1. 백엔드 API 서버 구현 ✅
- `server/` 폴더에 Hono 기반 API 완전 구현
- Sessions CRUD API (조회/생성/수정/삭제)
- Storage API (업로드/다운로드/Signed URL/삭제)
- JWT 인증 미들웨어
- RLS 우회를 위한 service_role 클라이언트 사용

### 2. 클라이언트 API 레이어 구현 ✅
- `src/lib/api/client.ts` - 인증 토큰 포함 fetch 래퍼
- `src/lib/api/sessions.ts` - Sessions API 클라이언트
- `src/lib/api/storage.ts` - Storage API 클라이언트

### 3. 기존 코드 어댑터화 ✅
- `sessionMapper.ts` - 백엔드 API 우선 사용, Supabase 폴백
- `storageUpload.ts` - 백엔드 API 우선 사용, Supabase 폴백
- 기존 29개 파일 코드 수정 없이 자동으로 새 API 사용

---

## 🚀 설정 및 실행 방법

### 1. 환경 변수 설정

프로젝트 루트에 `.env` 파일을 생성하고 다음 내용을 추가하세요:

```bash
# ── Supabase Configuration ──────────────────────────────────────
# 클라이언트 (브라우저)
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here

# 백엔드 API (서버 전용)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here

# ── Backend API Configuration ───────────────────────────────────
# 서버 포트 (기본: 3001)
PORT=3001

# CORS 허용 origin (프론트엔드 URL)
CORS_ORIGIN=http://localhost:5173

# ── Client Configuration ────────────────────────────────────────
# 백엔드 API URL (클라이언트에서 사용)
VITE_API_URL=http://localhost:3001
```

#### 🔑 Supabase 키 확인 방법
1. [Supabase Dashboard](https://app.supabase.com) 접속
2. 프로젝트 선택
3. Settings → API
4. **Project URL**: `VITE_SUPABASE_URL`, `SUPABASE_URL`에 복사
5. **anon public**: `VITE_SUPABASE_ANON_KEY`에 복사
6. **service_role**: `SUPABASE_SERVICE_ROLE_KEY`에 복사

⚠️ **중요**: `SUPABASE_SERVICE_ROLE_KEY`는 절대 클라이언트 코드에 노출하지 마세요!

---

### 2. 개발 서버 실행

#### 방법 1: 프론트엔드 + 백엔드 동시 실행 (권장)
```bash
npm run dev:all
```
- 프론트엔드: http://localhost:5173
- 백엔드: http://localhost:3001

#### 방법 2: 각각 실행
```bash
# 터미널 1 - 프론트엔드
npm run dev

# 터미널 2 - 백엔드
npm run dev:server
```

---

### 3. 작동 확인

#### 백엔드 API 헬스 체크
```bash
curl http://localhost:3001/health
```
예상 결과:
```json
{"status":"ok"}
```

#### 브라우저 콘솔 확인
1. 프론트엔드 앱 실행: http://localhost:5173
2. 브라우저 개발자 도구 → Console 탭
3. 다음 로그 확인:
   - `[loadAllSessions] Backend API 호출 시작`
   - `[loadAllSessions] Backend API: N건`
   - `[upsertToSupabase] Backend API 사용: N건`

---

## 🔄 동작 방식

### 백엔드 API 우선 전략

```
┌─────────────────────────────────────────┐
│ 클라이언트 코드                          │
│ (HomePage, AssetsPage, etc.)            │
└──────────────┬──────────────────────────┘
               │ loadAllSessions()
               │ saveAllSessions()
               ▼
┌─────────────────────────────────────────┐
│ sessionMapper.ts (어댑터)                │
│ ┌─────────────────────────────────────┐ │
│ │ 1. VITE_API_URL 설정되어 있나?      │ │
│ │    ├─ YES → Backend API 호출        │ │
│ │    │         (apiFetchSessions)      │ │
│ │    │         ↓                       │ │
│ │    │         성공? → 반환            │ │
│ │    │         실패? → Supabase 폴백  │ │
│ │    │                                 │ │
│ │    └─ NO → Supabase 직접 호출       │ │
│ └─────────────────────────────────────┘ │
└──────────────┬──────────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌─────────────┐  ┌──────────────┐
│ Backend API │  │  Supabase    │
│ (Hono)      │  │  (직접 호출) │
└─────────────┘  └──────────────┘
```

### 장점
✅ **점진적 마이그레이션**: 기존 코드 수정 없이 자동으로 새 API 사용
✅ **안전한 폴백**: 백엔드 API 실패 시 자동으로 Supabase 사용
✅ **보안 강화**: service_role 키가 클라이언트에 노출되지 않음
✅ **유연한 배포**: 백엔드 API 없이도 앱 작동 가능

---

## 🧪 테스트 플로우

### 1. 세션 로드 테스트
1. 앱 실행 (http://localhost:5173)
2. 홈 화면 → 자산 탭 이동
3. 콘솔 로그 확인:
   ```
   [loadAllSessions] Backend API 호출 시작
   [loadAllSessions] Backend API: 10건
   ```

### 2. 세션 저장 테스트
1. 자산 스캔 버튼 클릭
2. 스캔 완료 후 콘솔 로그 확인:
   ```
   [upsertToSupabase] Backend API 사용: 10건
   ```

### 3. 오디오 업로드 테스트
1. 공개 준비 실행
2. 콘솔 로그 확인:
   ```
   [uploadSanitizedAudio] Backend API 성공
   ```

### 4. 백엔드 API 장애 테스트
1. 백엔드 서버 중지 (Ctrl+C)
2. 앱에서 작업 수행
3. 콘솔 로그 확인:
   ```
   [loadAllSessions] Backend API 실패, Supabase 폴백
   [loadAllSessions] remote(Supabase): 10건
   ```
4. **예상 동작**: 앱이 정상 작동 (Supabase 폴백)

---

## 🐛 문제 해결

### 1. "Backend API 실패" 로그가 보여요
**원인**: 백엔드 서버가 실행되지 않았거나 VITE_API_URL이 잘못됨
**해결**:
```bash
# 백엔드 서버 실행 확인
curl http://localhost:3001/health

# .env 파일 확인
grep VITE_API_URL .env
```

### 2. "인증이 필요합니다" 오류
**원인**: JWT 토큰이 만료되었거나 없음
**해결**:
1. 로그아웃 후 재로그인
2. localStorage 확인 → `supabase.auth.token` 존재 여부

### 3. CORS 오류
**원인**: 백엔드 서버의 CORS 설정 불일치
**해결**:
```bash
# .env 파일 확인
CORS_ORIGIN=http://localhost:5173  # 프론트엔드 URL과 일치해야 함
```

### 4. service_role 권한 오류
**원인**: `SUPABASE_SERVICE_ROLE_KEY`가 잘못됨
**해결**:
1. Supabase Dashboard → Settings → API
2. **service_role** 키 재확인 및 복사
3. `.env` 파일 업데이트 후 백엔드 재시작

---

## 📊 API 엔드포인트 목록

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

---

## 🚢 프로덕션 배포

### 환경 변수 설정
```bash
# Cloudflare Workers / Vercel / Railway 등에서 설정
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
PORT=3001
CORS_ORIGIN=https://your-frontend-domain.com
```

### 권장 플랫폼
- **Cloudflare Workers**: 월 10만 요청 무료
- **Vercel Edge Functions**: 간편 배포
- **Railway / Render**: Docker 지원

자세한 배포 가이드는 [BACKEND_API.md](./BACKEND_API.md)를 참고하세요.

---

## 📝 체크리스트

### 초기 설정
- [ ] `.env` 파일 생성 및 설정
- [ ] Supabase 프로젝트 URL/키 확인
- [ ] `npm install` 실행

### 개발 환경 테스트
- [ ] `npm run dev:all` 실행
- [ ] http://localhost:3001/health 접속 (Backend API)
- [ ] http://localhost:5173 접속 (Frontend)
- [ ] 브라우저 콘솔에서 "Backend API" 로그 확인
- [ ] 세션 로드/저장 정상 작동 확인

### 기능 테스트
- [ ] 자산 스캔 → Backend API로 저장
- [ ] 공개 준비 → Backend API로 오디오 업로드
- [ ] 백엔드 서버 중지 → Supabase 폴백 작동 확인

---

## 🎉 완료!

이제 클라이언트가 백엔드 API를 통해 Supabase와 안전하게 통신합니다.
기존 29개 파일은 코드 수정 없이 자동으로 새 API를 사용합니다.

**다음 단계**: 프로덕션 배포 및 모니터링 설정
