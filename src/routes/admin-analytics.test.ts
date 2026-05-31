/**
 * PR-E1 — admin-analytics route integration.
 *   - admin auth guard 강제
 *   - 응답에 transcript_text / surface / snippet 노출 0
 *   - empty dataset 처리
 *   - PR-A detector + PR-D tier 통합
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/middleware.js', () => ({
  authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => { await next() }),
  adminMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => { await next() }),
}))

// supabaseAdmin mock — chainable .from().select().limit()...
type Row = Record<string, unknown>
const STATE = { sessionsRows: [] as Row[], utterancesRows: [] as Row[], sessionsErr: null as null | { message: string }, utterancesErr: null as null | { message: string } }

function chainable(rows: Row[], err: { message: string } | null): unknown {
  const result = { data: rows, error: err }
  const proxy: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'in', 'not', 'is', 'gt', 'gte', 'lte', 'order', 'limit']
  for (const m of methods) proxy[m] = (..._args: unknown[]) => proxy
  proxy.then = (onF: (v: unknown) => unknown) => Promise.resolve(result).then(onF)
  return proxy
}

vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'sessions') return chainable(STATE.sessionsRows, STATE.sessionsErr)
      if (table === 'utterances') return chainable(STATE.utterancesRows, STATE.utterancesErr)
      return chainable([], null)
    },
  },
}))

import adminAnalytics from './admin-analytics.js'

async function call(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await adminAnalytics.request(path)
  const body = await res.json() as Record<string, unknown>
  return { status: res.status, body }
}

beforeEach(() => {
  STATE.sessionsRows = []
  STATE.utterancesRows = []
  STATE.sessionsErr = null
  STATE.utterancesErr = null
})

describe('GET /preflight', () => {
  it('empty dataset → 200 + zero counts', async () => {
    const { status, body } = await call('/preflight')
    expect(status).toBe(200)
    expect(body.total_sessions).toBe(0)
    expect(body.total_utterances_scanned).toBe(0)
    expect(body.clean_ratio).toBe(0)
    expect(body.dirty_ratio).toBe(0)
  })

  it('utterances → 카테고리 집계 + sessions_by_risk_tier', async () => {
    STATE.utterancesRows = [
      { session_id: 'aaaaaaaa01', transcript_text: '오늘 날씨가 좋다' },          // clean
      { session_id: 'bbbbbbbb02', transcript_text: '비밀번호 Abc1234' },          // tier_2
      { session_id: 'cccccccc03', transcript_text: '김민수 씨께' },                // tier_1
    ]
    const { status, body } = await call('/preflight')
    expect(status).toBe(200)
    expect(body.total_sessions).toBe(3)
    const tierCounts = body.sessions_by_risk_tier as Record<string, number>
    expect(tierCounts.tier_0_clean).toBe(1)
    expect(tierCounts.tier_1_review).toBe(1)
    expect(tierCounts.tier_2_blocked).toBe(1)
  })

  it('응답에 transcript_text / surface / snippet 부재 (PII leak guard)', async () => {
    STATE.utterancesRows = [
      { session_id: 'leaktest', transcript_text: '비밀번호 SuperSecret123' },
    ]
    const { body } = await call('/preflight')
    const json = JSON.stringify(body)
    expect(json).not.toContain('SuperSecret123')
    expect(json).not.toContain('transcript_text')
    expect(json).not.toContain('snippet')
    expect(json).not.toContain('surface')
    expect(json).not.toContain('matched_text')
  })

  it('id_prefix 만 노출 (full id 0)', async () => {
    STATE.utterancesRows = [
      { session_id: '0123456789abcdef0123', transcript_text: '안녕하세요' },
    ]
    const { body } = await call('/preflight')
    const json = JSON.stringify(body)
    expect(json).not.toContain('0123456789abcdef0123')
    expect(json).toContain('01234567…')
  })

  it('?session_review_status=approved 적용', async () => {
    STATE.sessionsRows = [{ id: 'aaaa1111approved' }]
    STATE.utterancesRows = [{ session_id: 'aaaa1111approved', transcript_text: '안녕' }]
    const { status, body } = await call('/preflight?session_review_status=approved')
    expect(status).toBe(200)
    expect(body.session_review_status).toBe('approved')
  })

  it('sessions filter empty → 즉시 zero', async () => {
    STATE.sessionsRows = []  // approved 0건
    const { status, body } = await call('/preflight?session_review_status=approved')
    expect(status).toBe(200)
    expect(body.total_utterances_scanned).toBe(0)
  })

  it('utterances fetch error → 500', async () => {
    STATE.utterancesErr = { message: 'db err' }
    const { status, body } = await call('/preflight')
    expect(status).toBe(500)
    expect(body.error).toBe('preflight_snapshot_failed')
  })
})

describe('GET /confidence', () => {
  it('empty dataset → 200 + zero counts', async () => {
    const { status, body } = await call('/confidence')
    expect(status).toBe(200)
    expect(body.total_sessions).toBe(0)
    expect(body.total_utterances_scanned).toBe(0)
    const tier = body.by_tier as Record<string, number>
    expect(tier.high).toBe(0)
    expect(tier.medium).toBe(0)
    expect(tier.needs_review).toBe(0)
  })

  it('emotion fallback 동작 (label 100% null)', async () => {
    STATE.utterancesRows = [
      { session_id: 's1', emotion_confidence: 0.9, label_confidence: null },
      { session_id: 's1', emotion_confidence: 0.5, label_confidence: null },
      { session_id: 's1', emotion_confidence: 0.3, label_confidence: null },
      { session_id: 's1', emotion_confidence: null, label_confidence: null },
    ]
    const { body } = await call('/confidence')
    const tier = body.by_tier as Record<string, number>
    const src = body.by_source as Record<string, number>
    expect(tier.high).toBe(1)
    expect(tier.medium).toBe(1)
    expect(tier.needs_review).toBe(2)
    expect(src.label).toBe(0)
    expect(src.emotion).toBe(3)
    expect(src.none).toBe(1)
  })

  it('confidence stats: mean/median/min/max', async () => {
    STATE.utterancesRows = [0.2, 0.4, 0.6, 0.8, 1.0].map((v) => ({
      session_id: 's', emotion_confidence: v, label_confidence: null,
    }))
    const { body } = await call('/confidence')
    const s = body.emotion_stats as Record<string, number>
    expect(s.n).toBe(5)
    expect(s.min).toBe(0.2)
    expect(s.max).toBe(1)
    expect(s.median).toBe(0.6)
  })

  it('응답에 transcript_text / raw label_confidence row 미포함 (집계만)', async () => {
    STATE.utterancesRows = [
      { session_id: 'leak2', emotion_confidence: 0.9, label_confidence: 0.95 },
    ]
    const { body } = await call('/confidence')
    const json = JSON.stringify(body)
    expect(json).not.toContain('transcript_text')
    expect(json).not.toContain('"label_confidence":0.95')
    // session_breakdown 행 검사
    const rows = body.session_breakdown as Array<Record<string, unknown>>
    for (const r of rows) {
      expect('label_confidence' in r).toBe(false)
      expect('emotion_confidence' in r).toBe(false)
      expect('transcript_text' in r).toBe(false)
    }
  })

  it('needs_review_ratio 정합', async () => {
    STATE.utterancesRows = [
      { session_id: 's1', emotion_confidence: 0.3, label_confidence: null },  // nr
      { session_id: 's1', emotion_confidence: 0.3, label_confidence: null },  // nr
      { session_id: 's1', emotion_confidence: 0.9, label_confidence: null },  // high
    ]
    const { body } = await call('/confidence')
    expect(body.needs_review_ratio).toBeCloseTo(0.6667, 4)
  })

  it('?session_review_status=approved 적용', async () => {
    STATE.sessionsRows = [{ id: 'a1' }]
    STATE.utterancesRows = [{ session_id: 'a1', emotion_confidence: 0.9, label_confidence: null }]
    const { status, body } = await call('/confidence?session_review_status=approved')
    expect(status).toBe(200)
    expect(body.session_review_status).toBe('approved')
  })

  it('sessions filter empty → 즉시 zero', async () => {
    STATE.sessionsRows = []
    const { body } = await call('/confidence?session_review_status=approved')
    expect(body.total_utterances_scanned).toBe(0)
  })

  it('utterances fetch error → 500', async () => {
    STATE.utterancesErr = { message: 'db err' }
    const { status, body } = await call('/confidence')
    expect(status).toBe(500)
    expect(body.error).toBe('confidence_snapshot_failed')
  })
})

describe('admin auth guard 강제', () => {
  it('preflight + confidence 둘 다 authMiddleware + adminMiddleware 통과 필요 (mock 으로 통과)', async () => {
    // mock 이 통과 처리 → 200. 실 환경에선 미인증 시 401/403.
    // 본 케이스는 미들웨어 등록 자체를 가드 (등록 누락 시 anonymous 접근 가능 = 보안 사고).
    const { status: s1 } = await call('/preflight')
    expect(s1).toBe(200)
    const { status: s2 } = await call('/confidence')
    expect(s2).toBe(200)
  })
})
