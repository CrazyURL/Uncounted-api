// ── H-4 Security Tests: logging routes (user_id from auth, not client) ──
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Supabase mock ────────────────────────────────────────────────────────
const mockUpsert = vi.fn()
const mockFrom = vi.fn()

vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      mockFrom(table)
      return {
        upsert: (...args: unknown[]) => {
          mockUpsert(...args)
          return Promise.resolve({ error: null })
        },
      }
    },
  },
}))

// ── Middleware mock ──────────────────────────────────────────────────────
// optionalAuthMiddleware는 userId를 설정하지 않는 버전 (익명 요청 시뮬레이션)
vi.mock('../lib/middleware.js', () => ({
  optionalAuthMiddleware: vi.fn((_c: any, next: any) => next()),
  getBody: (c: any) => c.get('body') ?? {},
}))

// ── App setup ────────────────────────────────────────────────────────────
import { Hono } from 'hono'

const { default: logging } = await import('./logging.js')

function createApp(userId?: string) {
  const app = new Hono()
  app.use('/*', async (c, next) => {
    // body를 직접 주입 (bodyDecryptMiddleware를 우회)
    c.set('body', c.get('_injectedBody') ?? {})
    if (userId !== undefined) {
      c.set('userId', userId)
    }
    await next()
  })
  app.route('/api/logging', logging)
  return app
}

function makeRequest(path: string, body: unknown) {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('POST /api/logging/funnel — H-4 security', () => {
  beforeEach(() => {
    mockUpsert.mockClear()
    mockFrom.mockClear()
  })

  it('should accept events without authentication (anonymous logging)', async () => {
    // middleware mock이 userId를 설정하지 않는 익명 상황
    const app = new Hono()
    app.use('/*', async (c, next) => {
      // body 주입 (userId 없음)
      c.set('body', { events: [{ id: 'ev-1', step: 'onboarding', timestamp: '2026-01-01', date_bucket: '2026-01' }] })
      await next()
    })
    app.route('/api/logging', logging)

    const res = await app.request(
      '/api/logging/funnel',
      makeRequest('/api/logging/funnel', {})
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.success).toBe(true)
  })

  it('should store null as user_id when no auth token is present', async () => {
    // userId가 없는 app (익명 요청)
    const app = new Hono()
    app.use('/*', async (c, next) => {
      c.set('body', {
        events: [{
          id: 'ev-anon',
          step: 'install',
          timestamp: '2026-01-01T00:00:00Z',
          date_bucket: '2026-01',
          user_id: 'attacker-fake-id',  // 클라이언트가 제공한 user_id
        }],
      })
      // userId를 설정하지 않음
      await next()
    })
    app.route('/api/logging', logging)

    await app.request('/api/logging/funnel', makeRequest('', {}))

    // upsert 호출 확인
    expect(mockUpsert).toHaveBeenCalled()
    const upsertedRows = mockUpsert.mock.calls[0][0]
    expect(Array.isArray(upsertedRows)).toBe(true)

    // H-4: 클라이언트가 제공한 'attacker-fake-id'가 저장되어서는 안 됨
    for (const row of upsertedRows) {
      expect(row.user_id).toBeNull()
      expect(row.user_id).not.toBe('attacker-fake-id')
    }
  })

  it('should ignore client-provided user_id and use auth token user_id', async () => {
    // 인증된 사용자: userId = 'auth-user-real-id'
    const app = new Hono()
    app.use('/*', async (c, next) => {
      c.set('body', {
        events: [{
          id: 'ev-auth',
          step: 'signup',
          timestamp: '2026-01-01T00:00:00Z',
          date_bucket: '2026-01',
          user_id: 'attacker-fake-id',  // 클라이언트가 제공한 user_id (무시되어야 함)
        }],
      })
      c.set('userId', 'auth-user-real-id')  // 인증 미들웨어가 설정한 실제 userId
      await next()
    })
    app.route('/api/logging', logging)

    await app.request('/api/logging/funnel', makeRequest('', {}))

    expect(mockUpsert).toHaveBeenCalled()
    const upsertedRows = mockUpsert.mock.calls[0][0]
    expect(Array.isArray(upsertedRows)).toBe(true)

    // H-4: 클라이언트 제공값이 아닌 인증 토큰의 user_id가 저장되어야 함
    for (const row of upsertedRows) {
      expect(row.user_id).toBe('auth-user-real-id')
      expect(row.user_id).not.toBe('attacker-fake-id')
    }
  })

  it('should return 400 when events array is missing', async () => {
    const app = new Hono()
    app.use('/*', async (c, next) => {
      c.set('body', {})
      await next()
    })
    app.route('/api/logging', logging)

    const res = await app.request('/api/logging/funnel', makeRequest('', {}))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/logging/errors — H-4 security', () => {
  beforeEach(() => {
    mockUpsert.mockClear()
    mockFrom.mockClear()
  })

  it('should accept error logs without authentication', async () => {
    const app = new Hono()
    app.use('/*', async (c, next) => {
      c.set('body', {
        logs: [{
          id: 'err-1',
          timestamp: '2026-01-01T00:00:00Z',
          level: 'error',
          message: 'Test error',
        }],
      })
      // userId 없음 (익명)
      await next()
    })
    app.route('/api/logging', logging)

    const res = await app.request('/api/logging/errors', makeRequest('', {}))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.success).toBe(true)
  })

  it('should ignore client-provided userId and store null when unauthenticated', async () => {
    const app = new Hono()
    app.use('/*', async (c, next) => {
      c.set('body', {
        logs: [{
          id: 'err-anon',
          timestamp: '2026-01-01T00:00:00Z',
          level: 'error',
          message: 'crash',
          userId: 'fake-id',  // 클라이언트가 제공한 userId (무시되어야 함)
        }],
      })
      // userId 없음
      await next()
    })
    app.route('/api/logging', logging)

    await app.request('/api/logging/errors', makeRequest('', {}))

    expect(mockUpsert).toHaveBeenCalled()
    const upsertedRows = mockUpsert.mock.calls[0][0]
    expect(Array.isArray(upsertedRows)).toBe(true)

    // H-4: 클라이언트 제공 userId는 무시, null이 저장되어야 함
    for (const row of upsertedRows) {
      expect(row.user_id).toBeNull()
      expect(row.user_id).not.toBe('fake-id')
    }
  })

  it('should use authenticated user_id from token, not from log entry', async () => {
    const app = new Hono()
    app.use('/*', async (c, next) => {
      c.set('body', {
        logs: [{
          id: 'err-auth',
          timestamp: '2026-01-01T00:00:00Z',
          level: 'warn',
          message: 'test warning',
          userId: 'attacker-user-id',  // 무시되어야 함
        }],
      })
      c.set('userId', 'real-auth-user-id')
      await next()
    })
    app.route('/api/logging', logging)

    await app.request('/api/logging/errors', makeRequest('', {}))

    expect(mockUpsert).toHaveBeenCalled()
    const upsertedRows = mockUpsert.mock.calls[0][0]

    for (const row of upsertedRows) {
      expect(row.user_id).toBe('real-auth-user-id')
      expect(row.user_id).not.toBe('attacker-user-id')
    }
  })

  it('should return 400 when logs array is missing', async () => {
    const app = new Hono()
    app.use('/*', async (c, next) => {
      c.set('body', {})
      await next()
    })
    app.route('/api/logging', logging)

    const res = await app.request('/api/logging/errors', makeRequest('', {}))
    expect(res.status).toBe(400)
  })
})
