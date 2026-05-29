// orphanFilter 단위 테스트 (순수 함수 + feature flag + 요약 로거).
// loadUtteranceCountMap (supabase 의존) 은 packageBuilder.test 의 통합 테스트에서 검증.

import { describe, it, expect } from 'vitest'

import {
  buildUtteranceCountMap,
  filterOrphanUtterances,
  isOrphanFilterEnabled,
  summarizeDroppedOrphans,
} from './orphanFilter.js'

const SESSION_A = '00000000-0000-4000-8000-00000000000a'
const SESSION_B = '00000000-0000-4000-8000-00000000000b'

interface Row {
  id?: string | null
  session_id?: string | null
  sequence_order?: number | null
  [k: string]: unknown
}

const mkRow = (
  session_id: string | null,
  sequence_order: number | null,
  extra: Record<string, unknown> = {},
): Row => ({ id: `u-${session_id}-${sequence_order}`, session_id, sequence_order, ...extra })

// ── isOrphanFilterEnabled ─────────────────────────────────────────────────

describe('isOrphanFilterEnabled', () => {
  it('default = true (env 미설정)', () => {
    expect(isOrphanFilterEnabled({})).toBe(true)
  })

  it("'false' 명시 → 비활성", () => {
    expect(isOrphanFilterEnabled({ EXPORT_ORPHAN_FILTER_ENABLED: 'false' })).toBe(false)
  })

  it("'true' 명시 → 활성", () => {
    expect(isOrphanFilterEnabled({ EXPORT_ORPHAN_FILTER_ENABLED: 'true' })).toBe(true)
  })

  it("'0' / 'no' / 그 외 → 활성 (안전 우선, 정확히 'false' 만 우회)", () => {
    expect(isOrphanFilterEnabled({ EXPORT_ORPHAN_FILTER_ENABLED: '0' })).toBe(true)
    expect(isOrphanFilterEnabled({ EXPORT_ORPHAN_FILTER_ENABLED: 'no' })).toBe(true)
    expect(isOrphanFilterEnabled({ EXPORT_ORPHAN_FILTER_ENABLED: 'maybe' })).toBe(true)
    expect(isOrphanFilterEnabled({ EXPORT_ORPHAN_FILTER_ENABLED: '' })).toBe(true)
  })
})

// ── filterOrphanUtterances 핵심 ──────────────────────────────────────────

describe('filterOrphanUtterances — 정상 케이스', () => {
  it('모든 utterance 가 [1..utterance_count] 범위 → 전부 kept', () => {
    const rows = [mkRow(SESSION_A, 1), mkRow(SESSION_A, 2), mkRow(SESSION_A, 3)]
    const map = new Map([[SESSION_A, 3]])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept).toHaveLength(3)
    expect(out.dropped).toHaveLength(0)
  })

  it('빈 입력 → 빈 출력', () => {
    const out = filterOrphanUtterances<Row>([], new Map())
    expect(out.kept).toHaveLength(0)
    expect(out.dropped).toHaveLength(0)
  })

  it('다중 세션, 모두 정상', () => {
    const rows = [
      mkRow(SESSION_A, 1),
      mkRow(SESSION_A, 2),
      mkRow(SESSION_B, 1),
    ]
    const map = new Map([
      [SESSION_A, 2],
      [SESSION_B, 1],
    ])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept).toHaveLength(3)
    expect(out.dropped).toHaveLength(0)
  })
})

describe('filterOrphanUtterances — orphan 차단 (옵션 X)', () => {
  it('sequence_order > utterance_count → drop', () => {
    const rows = [mkRow(SESSION_A, 1), mkRow(SESSION_A, 2), mkRow(SESSION_A, 3), mkRow(SESSION_A, 4)]
    const map = new Map([[SESSION_A, 2]])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept.map((r) => r.sequence_order)).toEqual([1, 2])
    expect(out.dropped.map((r) => r.sequence_order)).toEqual([3, 4])
  })

  it('curated marker (pii_reviewed_at) 있어도 orphan-range 면 drop (★ 옵션 X 정합성 우선)', () => {
    // 디렉터 결정 옵션 X: export 정합성 > curated 보존.
    const rows = [
      mkRow(SESSION_A, 1),
      mkRow(SESSION_A, 80, { pii_reviewed_at: '2026-05-01T00:00:00Z' }),
      mkRow(SESSION_A, 50, { quality_reviewed_by: 'admin@example' }),
    ]
    const map = new Map([[SESSION_A, 50]])
    const out = filterOrphanUtterances(rows, map)
    // seq=80 (curated) 는 drop, seq=50 (curated) 는 keep (utterance_count=50 이라 BETWEEN 통과)
    expect(out.kept.map((r) => r.sequence_order)).toEqual([1, 50])
    expect(out.dropped.map((r) => r.sequence_order)).toEqual([80])
  })

  it('curated marker (pii_masked_at) 있어도 orphan-range 면 drop', () => {
    const rows = [
      mkRow(SESSION_A, 100, { pii_masked_at: '2026-05-01T00:00:00Z' }),
    ]
    const map = new Map([[SESSION_A, 50]])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept).toHaveLength(0)
    expect(out.dropped).toHaveLength(1)
  })
})

describe('filterOrphanUtterances — fail-closed 케이스', () => {
  it('sequence_order = NULL → drop', () => {
    const rows = [mkRow(SESSION_A, null), mkRow(SESSION_A, 1)]
    const map = new Map([[SESSION_A, 1]])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept).toHaveLength(1)
    expect(out.dropped).toHaveLength(1)
  })

  it('sequence_order = 0 → drop', () => {
    const rows = [mkRow(SESSION_A, 0), mkRow(SESSION_A, 1)]
    const map = new Map([[SESSION_A, 1]])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept.map((r) => r.sequence_order)).toEqual([1])
    expect(out.dropped.map((r) => r.sequence_order)).toEqual([0])
  })

  it('sequence_order = NaN / Infinity → drop', () => {
    const rows = [
      { id: 'u-nan', session_id: SESSION_A, sequence_order: Number.NaN },
      { id: 'u-inf', session_id: SESSION_A, sequence_order: Number.POSITIVE_INFINITY },
    ]
    const map = new Map([[SESSION_A, 100]])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept).toHaveLength(0)
    expect(out.dropped).toHaveLength(2)
  })

  it('session_id = NULL → drop', () => {
    const rows = [mkRow(null, 1), mkRow(SESSION_A, 1)]
    const map = new Map([[SESSION_A, 1]])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept).toHaveLength(1)
    expect(out.dropped).toHaveLength(1)
  })

  it('session 이 Map 에 없음 (worker 미실행 / 누락) → 전부 drop', () => {
    const rows = [mkRow(SESSION_A, 1), mkRow(SESSION_A, 2)]
    const map = new Map<string, number>() // SESSION_A 없음
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept).toHaveLength(0)
    expect(out.dropped).toHaveLength(2)
  })

  it('utterance_count = 0 → 전부 drop (worker 실패 세션)', () => {
    const rows = [mkRow(SESSION_A, 1), mkRow(SESSION_A, 2)]
    const map = new Map([[SESSION_A, 0]])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept).toHaveLength(0)
    expect(out.dropped).toHaveLength(2)
  })

  it('utterance_count = 음수 (DB 손상 가설) → 전부 drop', () => {
    const rows = [mkRow(SESSION_A, 1)]
    const map = new Map([[SESSION_A, -5]])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept).toHaveLength(0)
    expect(out.dropped).toHaveLength(1)
  })
})

describe('filterOrphanUtterances — 대량 / 성능 sanity', () => {
  it('1,000 utterances 정상 처리', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => mkRow(SESSION_A, i + 1))
    const map = new Map([[SESSION_A, 1000]])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept).toHaveLength(1000)
    expect(out.dropped).toHaveLength(0)
  })

  it('절반 orphan 한 번에 분리', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => mkRow(SESSION_A, i + 1))
    const map = new Map([[SESSION_A, 500]])
    const out = filterOrphanUtterances(rows, map)
    expect(out.kept).toHaveLength(500)
    expect(out.dropped).toHaveLength(500)
  })
})

describe('filterOrphanUtterances — ordering 보존', () => {
  it('입력 순서를 그대로 유지 (drop 만 발생, reorder 0)', () => {
    const rows = [
      mkRow(SESSION_A, 5),
      mkRow(SESSION_A, 1),
      mkRow(SESSION_A, 4),
      mkRow(SESSION_A, 2),
      mkRow(SESSION_A, 3),
    ]
    const map = new Map([[SESSION_A, 3]])
    const out = filterOrphanUtterances(rows, map)
    // utterance_count=3 → seq 1,2,3 keep, seq 4,5 drop.
    // ordering 은 입력 그대로: 입력에서 첫 keep 가 seq=1 (index 1)? 아니다, 입력 순서 5,1,4,2,3 에서
    // keep = seq ∈ {1,2,3} → 입력 등장 순서 → [1, 2, 3]
    expect(out.kept.map((r) => r.sequence_order)).toEqual([1, 2, 3])
    expect(out.dropped.map((r) => r.sequence_order)).toEqual([5, 4])
  })
})

// ── summarizeDroppedOrphans ──────────────────────────────────────────────

describe('buildUtteranceCountMap', () => {
  it('정상 행 → Map 엔트리', () => {
    const m = buildUtteranceCountMap([
      { id: SESSION_A, utterance_count: 3 },
      { id: SESSION_B, utterance_count: 5 },
    ])
    expect(m.get(SESSION_A)).toBe(3)
    expect(m.get(SESSION_B)).toBe(5)
    expect(m.size).toBe(2)
  })

  it('utterance_count NULL → 0', () => {
    const m = buildUtteranceCountMap([{ id: SESSION_A, utterance_count: null }])
    expect(m.get(SESSION_A)).toBe(0)
  })

  it('utterance_count 비숫자 (string 등) → 0', () => {
    const m = buildUtteranceCountMap([
      { id: SESSION_A, utterance_count: '5' as unknown },
      { id: SESSION_B, utterance_count: Number.NaN },
    ])
    expect(m.get(SESSION_A)).toBe(0)
    expect(m.get(SESSION_B)).toBe(0)
  })

  it('id 누락/비-string → 스킵', () => {
    const m = buildUtteranceCountMap([
      { id: null, utterance_count: 1 },
      { id: '', utterance_count: 2 },
      { id: SESSION_A, utterance_count: 3 },
    ])
    expect(m.size).toBe(1)
    expect(m.get(SESSION_A)).toBe(3)
  })

  it('빈 입력 → 빈 Map', () => {
    expect(buildUtteranceCountMap([]).size).toBe(0)
  })
})

describe('summarizeDroppedOrphans', () => {
  it('빈 dropped → 0 / 빈 객체 / 빈 샘플', () => {
    const s = summarizeDroppedOrphans<Row>([])
    expect(s.totalDropped).toBe(0)
    expect(s.perSessionCount).toEqual({})
    expect(s.sampleUtteranceIds).toEqual([])
  })

  it('per-session count + 샘플 ID 최대 N개', () => {
    const dropped: Row[] = [
      mkRow(SESSION_A, 100),
      mkRow(SESSION_A, 101),
      mkRow(SESSION_B, 99),
    ]
    const s = summarizeDroppedOrphans(dropped, 5)
    expect(s.totalDropped).toBe(3)
    expect(s.perSessionCount[SESSION_A]).toBe(2)
    expect(s.perSessionCount[SESSION_B]).toBe(1)
    expect(s.sampleUtteranceIds).toHaveLength(3) // 3 < maxSamples 5
  })

  it('maxSamples 한도 적용', () => {
    const dropped: Row[] = Array.from({ length: 20 }, (_, i) =>
      mkRow(SESSION_A, 100 + i),
    )
    const s = summarizeDroppedOrphans(dropped, 5)
    expect(s.totalDropped).toBe(20)
    expect(s.sampleUtteranceIds).toHaveLength(5)
  })

  it('session_id 없는 row 는 <no-session> 키로 집계', () => {
    const dropped: Row[] = [mkRow(null, 1), mkRow(null, 2)]
    const s = summarizeDroppedOrphans(dropped, 10)
    expect(s.totalDropped).toBe(2)
    expect(s.perSessionCount['<no-session>']).toBe(2)
  })

  it('id 가 없는 row 는 샘플에서 제외 (출력은 PII-free)', () => {
    const dropped: Row[] = [
      { session_id: SESSION_A, sequence_order: 100 }, // id 없음
      { id: 'u-1', session_id: SESSION_A, sequence_order: 101 },
    ]
    const s = summarizeDroppedOrphans(dropped, 10)
    expect(s.sampleUtteranceIds).toEqual(['u-1'])
  })
})
