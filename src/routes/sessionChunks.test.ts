// ── sessionChunks labels 업데이트 테스트 ──────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Supabase mock ────────────────────────────────────────────────────────
const mockUpdate = vi.fn()
const mockEq = vi.fn()
const mockIs = vi.fn()

function createChainMock(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, any> = {}
  chain.update = (...args: unknown[]) => {
    mockUpdate(...args)
    return chain
  }
  chain.eq = (...args: unknown[]) => {
    mockEq(...args)
    return chain
  }
  chain.is = (...args: unknown[]) => {
    mockIs(...args)
    return chain
  }
  // 최종 결과 — await 시 반환
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ error: overrides.error ?? null, count: overrides.count ?? 1 })
  return chain
}

let fromCalls: Array<{ table: string; chain: ReturnType<typeof createChainMock> }> = []
let sessionChainOverrides: Record<string, unknown> = {}

vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const overrides =
        table === 'sessions' ? sessionChainOverrides : {}
      const chain = createChainMock(overrides)
      fromCalls.push({ table, chain })
      return chain
    },
  },
}))

vi.mock('../lib/middleware.js', () => ({
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  getBody: (_c: any) => ({ labels: { tone: '중립적', noise: '낮음', purpose: '일상' } }),
}))

// ── App setup ────────────────────────────────────────────────────────────
import { Hono } from 'hono'

// 테스트 전에 mock 모듈 import
const { default: sessionChunks } = await import('./sessionChunks.js')

function createApp() {
  const app = new Hono()
  // userId를 주입하는 미들웨어
  app.use('/*', async (c, next) => {
    c.set('userId', 'user-123')
    c.set('body', { labels: { tone: '중립적', noise: '낮음', purpose: '일상' } })
    await next()
  })
  app.route('/api/session-chunks', sessionChunks)
  return app
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('PUT /api/session-chunks/:sessionId/:chunkIndex/labels', () => {
  beforeEach(() => {
    fromCalls = []
    sessionChainOverrides = {}
    mockUpdate.mockClear()
    mockEq.mockClear()
    mockIs.mockClear()
  })

  it('session_chunks update에 updated_at 필드가 포함되어야 한다', async () => {
    const app = createApp()
    const res = await app.request(
      '/api/session-chunks/007g6pxd/12/labels',
      { method: 'PUT', body: JSON.stringify({ labels: {} }), headers: { 'Content-Type': 'application/json' } }
    )
    expect(res.status).toBe(200)

    // session_chunks update 호출 확인
    const chunksCall = mockUpdate.mock.calls[0]
    expect(chunksCall).toBeDefined()
    expect(chunksCall[0]).toHaveProperty('labels')
    expect(chunksCall[0]).toHaveProperty('updated_at')
    expect(typeof chunksCall[0].updated_at).toBe('string')
  })

  it('sessions update에 updated_at 필드가 포함되어야 한다', async () => {
    const app = createApp()
    const res = await app.request(
      '/api/session-chunks/007g6pxd/12/labels',
      { method: 'PUT', body: JSON.stringify({ labels: {} }), headers: { 'Content-Type': 'application/json' } }
    )
    expect(res.status).toBe(200)

    // sessions update 호출 확인 (두 번째 update 호출)
    const sessionsCall = mockUpdate.mock.calls[1]
    expect(sessionsCall).toBeDefined()
    expect(sessionsCall[0]).toHaveProperty('labels')
    expect(sessionsCall[0]).toHaveProperty('label_source', 'auto')
    expect(sessionsCall[0]).toHaveProperty('updated_at')
    expect(typeof sessionsCall[0].updated_at).toBe('string')
  })

  it('sessions labels 업데이트 실패해도 200 응답을 반환해야 한다', async () => {
    sessionChainOverrides = {
      error: { message: "Could not find the 'updated_at' column" },
    }
    const app = createApp()
    const res = await app.request(
      '/api/session-chunks/007g6pxd/12/labels',
      { method: 'PUT', body: JSON.stringify({ labels: {} }), headers: { 'Content-Type': 'application/json' } }
    )

    // session labels 실패해도 chunk update는 성공했으므로 200
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('sessions.labels IS NULL 조건으로 필터링해야 한다', async () => {
    const app = createApp()
    await app.request(
      '/api/session-chunks/007g6pxd/12/labels',
      { method: 'PUT', body: JSON.stringify({ labels: {} }), headers: { 'Content-Type': 'application/json' } }
    )

    // .is('labels', null) 호출 확인
    expect(mockIs).toHaveBeenCalledWith('labels', null)
  })
})
