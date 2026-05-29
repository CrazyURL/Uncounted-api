// ── Export-side orphan utterance filter ───────────────────────────────────
//
// 설계: scripts/analysis/export_hardening_orphan_filter_20260529.md (read-only 정본)
// 정책 — 디렉터 결정(옵션 X, 2026-05-29): export 정합성 > curated 보존.
//   sequence_order > sessions.utterance_count 인 행은 curated 여부와 무관하게 drop.
//   (curated 보존은 voice-api PR #17 worker-side cleanup 의 책임; export 는 정합성 우선.)
//
// 동작:
//   1. orphan = sequence_order > sessions.utterance_count 또는 sequence_order 가 비정상.
//   2. fail-closed: session 이 map 에 없거나, utterance_count 가 NULL/0 이면 해당 session 의
//      모든 utterance 를 drop (export 가 silent 하게 stale 행을 포함하지 않도록).
//   3. feature flag `EXPORT_ORPHAN_FILTER_ENABLED`(default true) 가 'false' 일 때만 우회.
//
// 역할 분리 (worker-side cleanup vs export-side filter):
//   - worker (voice-api PR #17): 재처리 직후 DB 에서 stale orphan 행 물리 DELETE.
//     env-gated default OFF/DRY, curated 행은 보존 (보수적 7층 안전망).
//   - export (본 모듈): export ZIP 생성 시점에 메모리 필터. curated 라도 drop.
//   - 두 게이트 중 하나만 동작해도 buyer-facing 안전 (defense-in-depth).
//
// 의존: **본 모듈은 supabase 무의존 순수 함수만** (eligibility.ts / maskingProvenance.ts 패턴).
// sessions.utterance_count 사전 로딩은 호출자(packageBuilder.ts / export-builder.ts)가 담당.

/**
 * Feature flag — env `EXPORT_ORPHAN_FILTER_ENABLED` 가 'false' 명시일 때만 우회.
 * 미설정 / true / 그 외 값 → 필터 활성 (default true, 안전 우선).
 */
export function isOrphanFilterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXPORT_ORPHAN_FILTER_ENABLED !== 'false'
}

/** 입력 행 최소 형태. 기존 export 흐름의 `Record<string, unknown>` 와 호환. */
interface OrphanFilterInputRow {
  sequence_order?: number | null
  session_id?: string | null
  // 그 외 필드는 무시 (passthrough).
}

export interface OrphanFilterOutcome<T extends OrphanFilterInputRow> {
  kept: T[]
  dropped: T[]
}

/**
 * orphan 행 필터 (순수 함수).
 *
 * 의미적 WHERE: `u.sequence_order BETWEEN 1 AND COALESCE(s.utterance_count, 0)`
 *
 * 분류:
 *   - kept: sequence_order 가 [1, utterance_count] 범위인 정상 행.
 *   - dropped: 위 범위 밖 (= stale orphan) 또는 fail-closed 케이스.
 *
 * fail-closed 조건 (drop 으로 분류):
 *   - sequence_order 가 number 가 아니거나 NULL/undefined (DB constraint NOT NULL 이라 미발생 가정이지만 방어).
 *   - sequence_order < 1.
 *   - session_id 가 string 이 아님.
 *   - session_id 가 `sessionUtteranceCountById` 에 없음 (loadUtteranceCountMap 누락 → 보수적 drop).
 *   - utterance_count = 0 (worker 미실행 / 실패 세션 → 전부 drop).
 */
export function filterOrphanUtterances<T extends OrphanFilterInputRow>(
  utterances: T[],
  sessionUtteranceCountById: ReadonlyMap<string, number>,
): OrphanFilterOutcome<T> {
  const kept: T[] = []
  const dropped: T[] = []

  for (const row of utterances) {
    const seq = row.sequence_order
    const sid = row.session_id

    if (typeof sid !== 'string' || sid.length === 0) {
      dropped.push(row)
      continue
    }
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 1) {
      dropped.push(row)
      continue
    }

    const count = sessionUtteranceCountById.get(sid) ?? 0
    if (count <= 0 || seq > count) {
      dropped.push(row)
      continue
    }

    kept.push(row)
  }

  return { kept, dropped }
}

/**
 * `sessions.utterance_count` 단일/IN-list 응답을 Map 으로 정규화 (순수 함수).
 *
 * 호출자(packageBuilder / export-builder) 가 sessions 조회 결과를 그대로 넣으면 됨.
 * utterance_count 가 NULL / 비숫자 → 0 으로 정규화 (`filterOrphanUtterances` 가 자동 drop).
 */
export function buildUtteranceCountMap(
  sessionRows: ReadonlyArray<{ id?: unknown; utterance_count?: unknown }>,
): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of sessionRows) {
    if (typeof row.id !== 'string' || row.id.length === 0) continue
    const c =
      typeof row.utterance_count === 'number' && Number.isFinite(row.utterance_count)
        ? row.utterance_count
        : 0
    map.set(row.id, c)
  }
  return map
}

/**
 * dropped utterance 요약 로깅 (PII-free).
 *
 * 출력 형식: session_id (UUID) + 첫 N 개 utterance_id 만. transcript / storage_path 출력 금지.
 * 호출 빈도 = export 1회당 1번.
 */
export function summarizeDroppedOrphans<T extends OrphanFilterInputRow & { id?: string | null }>(
  dropped: T[],
  maxSamples: number = 10,
): { totalDropped: number; perSessionCount: Record<string, number>; sampleUtteranceIds: string[] } {
  const perSession: Record<string, number> = {}
  const sampleIds: string[] = []
  for (const row of dropped) {
    const sid = typeof row.session_id === 'string' ? row.session_id : '<no-session>'
    perSession[sid] = (perSession[sid] ?? 0) + 1
    if (sampleIds.length < maxSamples && typeof row.id === 'string' && row.id.length > 0) {
      sampleIds.push(row.id)
    }
  }
  return { totalDropped: dropped.length, perSessionCount: perSession, sampleUtteranceIds: sampleIds }
}
