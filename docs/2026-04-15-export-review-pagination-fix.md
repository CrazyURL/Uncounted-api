# Export 검수 제외 버그 수정 리포트

**날짜**: 2026-04-15
**영향 범위**: uncounted-api (백엔드), uncounted-admin (관리자 프론트), Supabase 스키마
**심각도**: High — 빌드 위자드에서 검수 단계의 "제외" 동작이 다운로드 패키지에 반영되지 않아, 의도한 범위보다 많은 발화가 납품될 수 있었음

---

## TL;DR

빌드 위자드의 검수 단계에서 체크박스로 발화를 제외해도 다운로드 ZIP에는 전체 발화가 그대로 담기는 증상이 있었다. 겉보기 원인은 하나였지만, 실제로는 **세 개의 독립된 버그가 연쇄**되어 있었다:

1. **#3 `bu_quality_metrics` RLS 정책 위반** — 품질 분석 단계에서 insert 실패
2. **#2 S3 업로드 `socket hang up`** — 패키징 완료 불가
3. **#1 Supabase 1000행 기본 제한** ← 사용자 증상의 진짜 원인. 프론트 검수 UI와 `packageBuilder` 쿼리 둘 다 1000행에서 잘려서 대규모 job(6700개 발화)에서 검수 대상과 패키징 대상이 서로 다른 1000개 집합이 됨

셋을 순서대로 수정한 뒤 정상 동작을 확인했다.

---

## 증상

- Job: `a6c8e088-316c-4bc3-90e0-b69a5c7b1116`
- 납품 대상 세션 16개, 총 발화 6700개
- 관리자 화면에서 1000개가 보였고, 그중 882개를 "제외"로 표시
- 기대값: 다운로드 ZIP에 `1000 - 882 = 118` 개 WAV
- 실제값: 다운로드 ZIP에 1000개 WAV 그대로 포함

---

## 이슈 #3 — `bu_quality_metrics` RLS 정책 위반

### 원인
마이그레이션 `022_bu_quality_metrics.sql`이 테이블에 이런 정책을 걸어뒀다:

```sql
ALTER TABLE bu_quality_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bqm_service_only" ON bu_quality_metrics
  FOR ALL USING (false) WITH CHECK (false);
```

이론상 `service_role`은 `BYPASSRLS = true`라서 통과해야 하지만, Supabase PostgREST의 `SET LOCAL ROLE service_role` 경로에서 BYPASSRLS가 **항상 무시되는 알려진 동작** 때문에 실제로는 모든 insert가 `new row violates row-level security policy`로 거부됐다.

이전에 `metadata_events`에서 동일한 패턴이 터졌고, `033_metadata_events_rls_fix.sql`에서 RLS를 비활성화하는 방식으로 해결한 전례가 있다.

### 수정
- 신규 마이그레이션: `uncounted-api/supabase/migrations/036_bu_quality_metrics_rls_fix.sql`

```sql
DROP POLICY IF EXISTS "bqm_service_only" ON bu_quality_metrics;
ALTER TABLE bu_quality_metrics DISABLE ROW LEVEL SECURITY;
```

이 테이블은 `supabaseAdmin`(service_role)으로만 접근하므로 RLS는 불필요.

### 확인 쿼리
```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class WHERE relname = 'bu_quality_metrics';
-- 기대: relrowsecurity = false
```

---

## 이슈 #2 — S3 업로드 `socket hang up`

### 원인
`uncounted-api/src/lib/s3.ts`의 `S3Client`가 AWS SDK 기본 HTTP 핸들러를 사용 중이었다. iwinv S3 호환 엔드포인트는 idle 연결을 빠르게 끊는 특성이 있는데, 기본 핸들러는:
- socket pooling 없이 매 요청마다 새 TCP/TLS 연결 수립
- keep-alive 미설정
- 명시적 timeout 없음

그 결과 대용량 multipart 업로드 중간에 `socket hang up`이 산발적으로 발생했다.

### 수정
`uncounted-api/src/lib/s3.ts` — `NodeHttpHandler` 명시적 주입 + keep-alive 풀:

```ts
const httpsAgent = new HttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
  maxFreeSockets: 16,
})
const httpAgent = new HttpAgent({ /* 동일 */ })

const requestHandler = new NodeHttpHandler({
  connectionTimeout: 10_000,   // TCP 수립 한도
  requestTimeout: 300_000,     // 5분 (대용량 part 여유)
  httpsAgent,
  httpAgent,
})

export const s3Client = new S3Client({
  endpoint, region, credentials,
  forcePathStyle: true,
  requestHandler,
  maxAttempts: 5,              // SDK 레벨 자동 재시도 (지수 backoff)
})
```

### 2차 방어선 — `buildPackage` 레벨 재시도
`uncounted-api/src/routes/admin-exports.ts`의 `runBuildPackageInBackground`에 transient 에러 분류 + 최대 3회 재시도 추가.

```ts
function isTransientNetworkError(err: unknown): boolean {
  // socket hang up / ECONNRESET / ETIMEDOUT / ECONNREFUSED / EAI_AGAIN /
  // TimeoutError / NetworkingError 등 분류
}

// transient면 2s → 4s → 8s backoff로 buildPackage 자체를 재시도
// 비 transient 또는 3회 실패면 fail_export_job 호출
```

### 두 단계 방어 구조
1. **SDK 레벨** (`maxAttempts: 5`): 실패한 part만 재시도
2. **buildPackage 레벨** (최대 3회): SDK 재시도도 다 실패하면 ZIP 빌드를 처음부터 재시도

---

## 이슈 #1 — Supabase 1000행 기본 제한 (핵심 버그)

### 원인
Supabase PostgREST는 단일 요청당 `MAX_ROWS=1000`이 기본값이다. `.range()`나 페이지네이션 없이 쿼리하면 **항상 1000행에서 잘린다**.

이번 사건에서 영향을 준 쿼리:

| 위치 | 용도 | 증상 |
|---|---|---|
| `admin-exports.ts:605` | 프론트의 검수 UI가 호출하는 `loadExportUtterances` v3 경로 | 6700개 중 첫 1000개만 반환 → 사용자는 그 1000개만 보고 검수 |
| `packageBuilder.ts:203` | 패키지 빌드 시 포함 대상 발화 조회 | `review_status IN ('pending','approved')` 필터 후 4955개가 매칭되지만 1000개만 반환 |
| `packageBuilder.ts:216` | 제외된 발화 ID 목록 조회 | 마찬가지로 cap |
| `packageBuilder.ts:240` | 레거시 `export_package_items` 폴백 | 마찬가지로 cap |
| `utteranceRepository.ts:104` | `getUtterancesByExportRequest` | 마찬가지로 cap |

더 나쁜 건: 프론트 쿼리는 `session_id, sequence_order`로, 빌더 쿼리는 `id`로 정렬해서 **두 쪽의 1000개 집합이 서로 다르다**. 그래서 "내가 UI에서 제외 체크한 항목"과 "빌더가 패키지에 넣은 항목"의 교집합이 사용자 기대와 완전히 어긋났다.

### DB 스냅샷 (수정 전)
```
locked_sessions           = 16
total_utterances          = 6700
excluded_by_review_status = 1745  ← review_status가 제대로 저장은 돼 있음
included_by_review_status = 4955
excluded_by_content_hash  = 0     ← v3 전용 job이라 레거시 경로 미사용
stored_package_count      = 1000  ← 여기가 cap
```

`[review]` 로그에서는 `updated=1000 failed=0 v3Matched=1000`으로 "정상" 같아 보였지만, 실제로는 **프론트가 받은 1000개에 한해서만 정상**이었다.

### 수정
모든 잠재 대량 쿼리를 페이지네이션 헬퍼로 교체.

#### 1. 공용 헬퍼 — `uncounted-api/src/lib/supabase.ts`

```ts
type QueryBuilderLike = {
  range: (from: number, to: number) => any
}

export async function fetchAllPaginated<T = Record<string, unknown>>(
  queryFactory: () => QueryBuilderLike,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = []
  let from = 0
  const HARD_CAP = 1_000_000  // 무한루프 방어
  while (from < HARD_CAP) {
    const to = from + pageSize - 1
    const result = await queryFactory().range(from, to)
    if (result.error) throw new Error(...)
    const rows = result.data ?? []
    all.push(...rows)
    if (rows.length < pageSize) break
    from += pageSize
  }
  return all
}
```

**주의**: `queryFactory`는 매 호출마다 **새 쿼리 빌더**를 반환해야 한다. Supabase 빌더는 chain 호출 시 내부 상태를 변경해 재사용할 수 없다.

#### 2. 교체한 호출 지점
- `packageBuilder.ts` — v3 utterances, 제외 ID 목록, legacy fallback
- `admin-exports.ts` — `loadExportUtterances` v3 경로
- `utteranceRepository.ts` — `getUtterancesByExportRequest`

#### 3. 디버그 로그
각 교체 지점에 반환된 실제 행 수를 로그로 남겨서 다음 cap 이슈를 즉시 포착:

```
[loadExportUtterances] job=<id> v3 returned 6700 utterances (paginated)
[buildPackage] job=<id> v3 query returned <N> utterances (pending/approved, paginated)
```

---

## 부가 수정 — 검수 엔드포인트 견고화

`admin-exports.ts`의 `PUT /export-requests/:id/utterances/review`는 원래 개별 업데이트 실패를 catch로 삼켰다 (`// skip individual failures`). 이번에 다음처럼 바꿨다:

1. v3 update / legacy update 각각에 `.select('id')` / `.select('utterance_id')`를 붙여 **실제 영향 행 수 검증**
2. `v3Rows === 0 && legacyRows === 0`이면 `failed++` + 실패 이유 기록
3. 응답 포맷 확장:
   ```json
   {
     "updated": 1000,
     "failed": 0,
     "total": 1000,
     "v3Matched": 1000,
     "legacyMatched": 0,
     "failures": [...]  // 실패 시 최대 10건
   }
   ```
4. `console.log('[review] ...')`로 요청/결과 요약 로그

프론트도 같은 흐름에 맞춰 가드 추가:
- `uncounted-admin/src/lib/api/admin.ts`: `ReviewUtterancesResult` 타입 추가
- `uncounted-admin/src/lib/adminStore.ts`: `reviewExportUtterances`가 결과 객체 반환
- `uncounted-admin/src/components/domain/AudioProcessingSteps.tsx`: `onFinalize`에서 `failed > 0`이면 경고 다이얼로그로 사용자 확인

---

## 검증 절차

1. **마이그레이션 036 적용** (dev/live 각각)
   ```sql
   DROP POLICY IF EXISTS "bqm_service_only" ON bu_quality_metrics;
   ALTER TABLE bu_quality_metrics DISABLE ROW LEVEL SECURITY;
   ```

2. **API 재시작**
   ```bash
   pm2 restart uncounted-api
   ```
   기대 로그:
   ```
   [s3] client initialized { ..., keepAlive: true, maxSockets: 64, requestTimeoutMs: 300000, maxAttempts: 5 }
   ```

3. **대규모 job 검수 플로우**
   - 새 export job 생성 → 검수 단계 진입
   - 기대: `[loadExportUtterances] job=<id> v3 returned <N> utterances (paginated)` (N = 전체 수, 1000 아님)
   - 프론트 UI에 전체 발화 표시
   - 일부 제외 체크 → 확정
   - 기대: `[review] job=<id> total=<N> ... result: updated=<N> v3Matched=<N>`
   - 기대: `[buildPackage] job=<id> v3 query returned <N - 제외수> utterances (pending/approved, paginated)`

4. **ZIP 검증**
   ```bash
   unzip -l package.zip | grep -c '\.wav$'
   # 기대: N - 제외수와 정확히 일치
   ```

5. **회귀**: 기존 소규모 job(1000개 이하)도 정상 동작 확인

---

## 남은 잠재 이슈 (별도 추적 권장)

### 기술 부채
- **`utterances` vs `export_package_items` 이중 관리**: 검수 제외 상태가 두 테이블에 동시 기록된다. 현재는 방어 코드로 막았지만 구조적으로 혼란스러움. v3 단일 소스(`utterances.review_status`)로 통일 권장.

### 다른 잠재 1000행 cap 위치
패키지 빌드 중 아래 쿼리들도 세션/유저 수가 커지면 cap 가능성:
- `packageBuilder.ts:260` `loadQualityMetrics(sessionIds)`
- `packageBuilder.ts:265` `users_profile` 조회
- `packageBuilder.ts:283` `billable_units` consent 조회
- `packageBuilder.ts:294` `loadTranscripts(sessionIds)`

현재 운영 규모에서는 문제 없어 보이지만, 장기적으로 `fetchAllPaginated`로 일괄 교체 권장.

### 최선의 예방책
PR 리뷰 체크리스트에 추가:
> `.from('...').select(...)` 뒤에 `.range()` 또는 `fetchAllPaginated`가 없는 쿼리는 **결과 행 수가 1000을 넘을 수 없음을 증명**하거나 페이지네이션으로 교체해야 한다.

---

## 변경 파일 목록

### 백엔드 (`uncounted-api/`)
- `supabase/migrations/036_bu_quality_metrics_rls_fix.sql` (신규)
- `src/lib/supabase.ts` — `fetchAllPaginated` 헬퍼 추가
- `src/lib/s3.ts` — `NodeHttpHandler` + keep-alive 풀 + `maxAttempts`
- `src/lib/export/packageBuilder.ts` — v3/legacy/제외목록 쿼리 페이지네이션
- `src/lib/export/utteranceRepository.ts` — `getUtterancesByExportRequest` 페이지네이션
- `src/routes/admin-exports.ts`:
  - `loadExportUtterances` v3 페이지네이션
  - `PUT /utterances/review` silent catch 제거 + 영향 행 수 검증
  - `runBuildPackageInBackground` transient 에러 재시도 래퍼

### 관리자 프론트 (`uncounted-admin/`)
- `src/lib/api/admin.ts` — `ReviewUtterancesResult` 타입
- `src/lib/adminStore.ts` — `reviewExportUtterances`가 결과 객체 반환
- `src/components/domain/AudioProcessingSteps.tsx` — `onFinalize`에 `failed > 0` 가드
- `src/components/domain/UtteranceReviewTable.tsx` — "선택 N건 활성화" 버튼 추가 (선행 작업)

---

## 교훈

1. **Supabase의 1000행 기본 cap은 조용한 데이터 손실을 만든다.** 쿼리는 에러 없이 성공하고 일부 행만 반환하므로 개발 단계에서는 쉽게 눈치 채지 못한다. 대량 데이터 경로는 **반드시 페이지네이션**.

2. **Silent catch는 해결책이 아니라 증상 은폐다.** `// skip individual failures`로 덮어둔 코드가 이번 사건에서 진단을 몇 시간 늦췄다. 실패는 카운트하고 로그로 드러내야 한다.

3. **여러 원인이 연쇄된 버그는 한 층씩 벗겨야 한다.** #3(RLS) → #2(S3) → #1(cap) 순서로 **하나가 풀려야 다음이 보였다**. 한꺼번에 다 고치려 하지 말고 진단 로그를 붙여 층을 분리할 것.

4. **`BYPASSRLS` 속성을 믿지 말 것 (Supabase에서).** PostgREST의 `SET LOCAL ROLE` 경로에서 BYPASSRLS가 무시되므로, 백엔드 전용 테이블은 `DISABLE ROW LEVEL SECURITY` 또는 `TO service_role USING (true)` 정책을 **명시적으로** 적어야 한다.
