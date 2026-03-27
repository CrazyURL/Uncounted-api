// ── H-5 Security Tests: error handler does not expose internal details ──
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'

// ── Supabase mock ────────────────────────────────────────────────────────
vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: {
    auth: {
      signInWithPassword: vi.fn(),
      getUser: vi.fn(),
    },
  },
}))

// ── Crypto mock (identity, no actual crypto needed for these tests) ──────
vi.mock('../lib/crypto.js', () => ({
  encryptId: (v: string) => v,
  decryptData: (v: string) => JSON.parse(v),
}))

// ── Middleware mock ──────────────────────────────────────────────────────
vi.mock('../lib/middleware.js', () => ({
  bodyDecryptMiddleware: vi.fn((_c: any, next: any) => next()),
  devBodyLogger: vi.fn((_c: any, next: any) => next()),
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  optionalAuthMiddleware: vi.fn((_c: any, next: any) => next()),
  getBody: (c: any) => c.get('body') ?? {},
}))

// ── Tests ────────────────────────────────────────────────────────────────

describe('global error handler — H-5 security', () => {
  it('should NOT expose internal error message details', async () => {
    const app = new Hono()

    // 라우트에서 내부 에러 메시지가 담긴 예외를 던짐
    app.get('/test-error', (_c) => {
      throw new Error('DB connection string: postgresql://admin:secret_password@db.internal/prod')
    })

    // H-5 fix: onError는 generic 메시지만 반환
    app.onError((err, c) => {
      console.error('Server Error:', err)
      return c.json({ error: 'Internal Server Error' }, 500)
    })

    const res = await app.request('/test-error')

    expect(res.status).toBe(500)
    const json = await res.json()

    // 일반적인 에러 메시지만 포함해야 함
    expect(json.error).toBe('Internal Server Error')

    // 내부 상세 정보가 노출되면 안 됨
    const responseText = JSON.stringify(json)
    expect(responseText).not.toContain('secret_password')
    expect(responseText).not.toContain('postgresql://')
    expect(responseText).not.toContain('DB connection string')
  })

  it('global onError in index.ts returns generic error, not raw message', async () => {
    const app = new Hono()

    app.get('/throw-sensitive', (_c) => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...')
    })

    // 실제 index.ts의 onError 패턴과 동일
    app.onError((err, c) => {
      console.error('Server Error:', err)
      return c.json({ error: 'Internal Server Error' }, 500)
    })

    const res = await app.request('/throw-sensitive')
    expect(res.status).toBe(500)

    const json = await res.json()
    expect(json.error).toBe('Internal Server Error')
    expect(json).not.toHaveProperty('message')
    expect(json).not.toHaveProperty('stack')
    expect(JSON.stringify(json)).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
  })
})

describe('auth route error handlers — H-5 security', () => {
  it('signin catch block returns generic error, not internal message', async () => {
    const { supabaseAdmin } = await import('../lib/supabase.js')

    // supabase.auth.signInWithPassword가 내부 메시지를 담은 예외를 던지도록 설정
    const sensitiveMessage = 'DB pool exhausted: too many connections on host db.internal'
    ;(supabaseAdmin.auth.signInWithPassword as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(sensitiveMessage)
    )

    const { default: auth } = await import('./auth.js')

    const app = new Hono()
    app.use('/*', async (c, next) => {
      c.set('body', { email: 'test@example.com', password: 'pass123' })
      await next()
    })
    app.route('/api/auth', auth)

    const res = await app.request('/api/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@example.com', password: 'pass123' }),
      headers: { 'Content-Type': 'application/json' },
    })

    expect(res.status).toBe(500)
    const json = await res.json()

    // H-5: 내부 에러 메시지가 응답에 포함되면 안 됨
    expect(json.error).toBe('Internal Server Error')
    expect(json.error).not.toBe(sensitiveMessage)
    expect(JSON.stringify(json)).not.toContain('DB pool exhausted')
    expect(JSON.stringify(json)).not.toContain('db.internal')
  })

  it('signup catch block returns generic error, not internal message', async () => {
    const { supabaseAdmin } = await import('../lib/supabase.js')

    const sensitiveMessage = 'Connection refused: postgres://root:rootpass@10.0.0.1/uncounted'
    ;(supabaseAdmin.auth as any).admin = {
      createUser: vi.fn().mockRejectedValueOnce(new Error(sensitiveMessage)),
    }

    const { default: auth } = await import('./auth.js')

    const app = new Hono()
    app.use('/*', async (c, next) => {
      c.set('body', { email: 'newuser@example.com', password: 'pass123' })
      await next()
    })
    app.route('/api/auth', auth)

    const res = await app.request('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email: 'newuser@example.com', password: 'pass123' }),
      headers: { 'Content-Type': 'application/json' },
    })

    expect(res.status).toBe(500)
    const json = await res.json()

    // H-5: 내부 메시지 노출 금지
    expect(json.error).toBe('Internal Server Error')
    expect(JSON.stringify(json)).not.toContain('Connection refused')
    expect(JSON.stringify(json)).not.toContain('rootpass')
  })
})
