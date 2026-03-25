---
paths: src/routes/**
---

# API 엔드포인트 전체 목록

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
| | `/api/admin/storage/metas` | GET | 어드민 | 전체 Meta JSONL 파일 목록 |
| | `/api/admin/storage/signed-url` | POST | 어드민 | 서명 URL 발급 (bucket: audio/meta) |
| | `/api/admin/session-chunks/batch-signed-urls` | POST | 어드민 | 청크 일괄 서명 URL |
| | `/api/admin/sync-audio-urls` | POST | 어드민 | 오디오 URL 동기화 |
| | `/api/admin/reset-all` | DELETE | 어드민 | 전체 데이터 초기화 |
