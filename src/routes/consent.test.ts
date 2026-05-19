// ── POST /api/consent/agree/:token 회귀 테스트 ──────────────────────────
// 2026-05-19: 옛 코드(48ddd6b)는 sessions promote 결과 count===0이면
//   422 + invitation을 'sent'로 롤백시켜 받는 분의 동의 자체를 차단.
// fix(a124d72)는 422 분기와 롤백을 제거하고 invitation.status='agreed'를
//   source of truth로 유지. 본 테스트가 그 동작을 lock-in.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Supabase chain mock ───────────────────────────────────────────────────
// 각 from() 호출을 인덱스로 매핑. result.count도 chain 결과에 포함됨.
let fromCallIdx = 0
let mockChainsByIdx: Array<{
  result?: { data: unknown; error: unknown; count?: number | null }
}> = []
let capturedUpdates: Array<{ tableIdx: number; payload: unknown }> = []
// PATCH 등 body 가 필요한 endpoint 테스트용 — 각 테스트에서 셋업
let mockBody: Record<string, unknown> = {}

vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: {
    from: (_table: string) => {
      const idx = fromCallIdx++
      const spec = mockChainsByIdx[idx] ?? {}
      const result = spec.result ?? { data: null, error: null }
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.update = (payload: unknown) => {
        capturedUpdates.push({ tableIdx: idx, payload })
        return chain
      }
      chain.insert = () => chain
      chain.in = () => chain
      chain.eq = () => chain
      chain.maybeSingle = () => Promise.resolve(result)
      chain.single = () => Promise.resolve(result)
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(result).then(resolve)
      return chain
    },
  },
}))

vi.mock('../lib/middleware.js', () => ({
  authMiddleware: vi.fn((c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-abc')
    return next()
  }),
  getBody: vi.fn(() => mockBody),
}))

// ── App setup ─────────────────────────────────────────────────────────────
import { Hono } from 'hono'

const { default: consent } = await import('./consent.js')

function createApp() {
  const app = new Hono()
  app.route('/api/consent', consent)
  return app
}

beforeEach(() => {
  fromCallIdx = 0
  mockChainsByIdx = []
  capturedUpdates = []
  mockBody = {}
})

describe('POST /api/consent/agree/:token', () => {
  it('회귀: sessions row가 0건이어도 invitation은 agreed로 기록되고 200 반환 (옛 코드는 422로 차단)', async () => {
    // [0] SELECT invitation by token
    mockChainsByIdx[0] = {
      result: {
        data: {
          id: 'inv-1',
          user_id: 'sender-001',
          session_id: 'sess-A',
          session_ids: ['sess-A'],
          token: 'tok-1',
          status: 'sent',
          expires_at: null,
        },
        error: null,
      },
    }
    // [1] UPDATE invitation → agreed
    mockChainsByIdx[1] = {
      result: {
        data: {
          id: 'inv-1',
          status: 'agreed',
          responded_at: '2026-05-19T10:00:00.000Z',
        },
        error: null,
      },
    }
    // [2] UPDATE sessions promote → count=0 (보낸 분 sessions row 없음 — 정상)
    mockChainsByIdx[2] = {
      result: { data: null, error: null, count: 0 },
    }

    const app = createApp()
    const res = await app.request('/api/consent/agree/tok-1', {
      method: 'POST',
    })

    // 옛 코드: 422. 새 코드: 200.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data?.status).toBe('agreed')

    // 옛 코드는 invitation을 'sent'로 되돌리는 추가 UPDATE를 호출했음.
    // 새 코드는 그 보상 트랜잭션이 제거됨 → from() 호출은 3번뿐.
    expect(fromCallIdx).toBe(3)

    // 'sent' 롤백 페이로드가 capture 안 됐는지 검증 (옛 코드는 status:'sent', responded_at:null로 update)
    const rollbackUpdate = capturedUpdates.find(
      (u) =>
        u.payload &&
        typeof u.payload === 'object' &&
        (u.payload as Record<string, unknown>).status === 'sent',
    )
    expect(rollbackUpdate).toBeUndefined()
  })

  it('회귀: promote가 DB 에러를 내도 invitation.agreed는 유지 + 200 반환', async () => {
    mockChainsByIdx[0] = {
      result: {
        data: {
          id: 'inv-err',
          user_id: 'sender-002',
          session_id: 'sess-B',
          session_ids: ['sess-B'],
          token: 'tok-err',
          status: 'sent',
          expires_at: null,
        },
        error: null,
      },
    }
    mockChainsByIdx[1] = {
      result: {
        data: { id: 'inv-err', status: 'agreed' },
        error: null,
      },
    }
    mockChainsByIdx[2] = {
      result: {
        data: null,
        error: { code: 'PG-99', message: 'simulated DB error' },
        count: null,
      },
    }

    const app = createApp()
    const res = await app.request('/api/consent/agree/tok-err', {
      method: 'POST',
    })

    // 옛 코드: 500 또는 422 + 롤백. 새 코드: 200 + invitation은 agreed 유지.
    expect(res.status).toBe(200)
    expect(fromCallIdx).toBe(3)

    const rollbackUpdate = capturedUpdates.find(
      (u) =>
        u.payload &&
        typeof u.payload === 'object' &&
        (u.payload as Record<string, unknown>).status === 'sent',
    )
    expect(rollbackUpdate).toBeUndefined()
  })

  it('sessions가 user_only로 존재하면 promote count > 0 으로 정상 동작', async () => {
    mockChainsByIdx[0] = {
      result: {
        data: {
          id: 'inv-ok',
          user_id: 'sender-003',
          session_id: 'sess-C1',
          session_ids: ['sess-C1', 'sess-C2'],
          token: 'tok-ok',
          status: 'sent',
          expires_at: null,
        },
        error: null,
      },
    }
    mockChainsByIdx[1] = {
      result: { data: { id: 'inv-ok', status: 'agreed' }, error: null },
    }
    mockChainsByIdx[2] = {
      result: { data: null, error: null, count: 2 },
    }

    const app = createApp()
    const res = await app.request('/api/consent/agree/tok-ok', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    expect(fromCallIdx).toBe(3)

    // sessions promote payload 확인 (both_agreed로 업데이트)
    const promoteUpdate = capturedUpdates.find(
      (u) =>
        u.payload &&
        typeof u.payload === 'object' &&
        (u.payload as Record<string, unknown>).consent_status === 'both_agreed',
    )
    expect(promoteUpdate).toBeDefined()
  })

  it('이미 agreed 상태인 invitation은 SELECT만 하고 멱등 200 반환', async () => {
    mockChainsByIdx[0] = {
      result: {
        data: {
          id: 'inv-idem',
          token: 'tok-idem',
          status: 'agreed',
          expires_at: null,
        },
        error: null,
      },
    }

    const app = createApp()
    const res = await app.request('/api/consent/agree/tok-idem', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    expect(fromCallIdx).toBe(1) // SELECT만, 후속 UPDATE 없음
  })

  it('declined 상태인 invitation은 409 반환', async () => {
    mockChainsByIdx[0] = {
      result: {
        data: {
          id: 'inv-dec',
          token: 'tok-dec',
          status: 'declined',
          expires_at: null,
        },
        error: null,
      },
    }

    const app = createApp()
    const res = await app.request('/api/consent/agree/tok-dec', {
      method: 'POST',
    })

    expect(res.status).toBe(409)
  })

  it('expired 토큰은 410 + status=expired로 마킹', async () => {
    mockChainsByIdx[0] = {
      result: {
        data: {
          id: 'inv-exp',
          token: 'tok-exp',
          status: 'sent',
          expires_at: '2020-01-01T00:00:00.000Z', // 과거
        },
        error: null,
      },
    }
    mockChainsByIdx[1] = { result: { data: null, error: null } }

    const app = createApp()
    const res = await app.request('/api/consent/agree/tok-exp', {
      method: 'POST',
    })

    expect(res.status).toBe(410)

    const expiredUpdate = capturedUpdates.find(
      (u) =>
        u.payload &&
        typeof u.payload === 'object' &&
        (u.payload as Record<string, unknown>).status === 'expired',
    )
    expect(expiredUpdate).toBeDefined()
  })

  it('미존재 토큰은 404', async () => {
    mockChainsByIdx[0] = { result: { data: null, error: null } }

    const app = createApp()
    const res = await app.request('/api/consent/agree/tok-none', {
      method: 'POST',
    })

    expect(res.status).toBe(404)
  })
})

// ── PATCH /api/consent/invitations/:id/status — terminal state guard ──────
// 2026-05-19: 보낸 분이 받는 분의 동의(agreed) 후 폰 앱에서 "발송완료" 클릭 시
//   PATCH 가 현재 상태 검사 없이 status='sent' + sent_at 으로 덮어쓰는 버그 발견.
// fix: terminal 상태(agreed/declined/expired) invitation 은 sent/opened 로 강등 거부.
//   atomic 가드 — UPDATE WHERE .in('status', ['pending','sent','opened']) +
//   0 rows 시 fallback SELECT 로 현재 row 멱등 반환.
describe('PATCH /api/consent/invitations/:id/status — terminal state guard', () => {
  it('회귀: agreed invitation 은 sent 로 강등 거부 (responded_at·status 보존)', async () => {
    // [0] UPDATE — .in() 가드로 0 rows (terminal 상태라 매칭 안 됨)
    mockChainsByIdx[0] = { result: { data: null, error: null } }
    // [1] SELECT fallback — 현재 invitation row (status='agreed' 유지)
    mockChainsByIdx[1] = {
      result: {
        data: {
          id: 'inv-agreed',
          user_id: 'user-abc',
          session_id: 'sess-A',
          status: 'agreed',
          responded_at: '2026-05-19T08:10:48.852Z',
          sent_at: null,
        },
        error: null,
      },
    }
    mockBody = { status: 'sent', shareMethod: 'web_share' }

    const app = createApp()
    const res = await app.request('/api/consent/invitations/inv-agreed/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mockBody),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('agreed') // 강등 거부
    expect(body.data.responded_at).toBe('2026-05-19T08:10:48.852Z') // 보존
  })

  it('회귀: declined invitation 은 sent 로 강등 거부', async () => {
    mockChainsByIdx[0] = { result: { data: null, error: null } }
    mockChainsByIdx[1] = {
      result: {
        data: {
          id: 'inv-declined',
          user_id: 'user-abc',
          status: 'declined',
          responded_at: '2026-05-19T07:00:00.000Z',
          sent_at: null,
        },
        error: null,
      },
    }
    mockBody = { status: 'sent' }

    const app = createApp()
    const res = await app.request('/api/consent/invitations/inv-declined/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mockBody),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).data.status).toBe('declined')
  })

  it('회귀: expired invitation 은 sent 로 강등 거부', async () => {
    mockChainsByIdx[0] = { result: { data: null, error: null } }
    mockChainsByIdx[1] = {
      result: {
        data: {
          id: 'inv-expired',
          user_id: 'user-abc',
          status: 'expired',
          sent_at: '2026-05-01T00:00:00.000Z',
        },
        error: null,
      },
    }
    mockBody = { status: 'sent' }

    const app = createApp()
    const res = await app.request('/api/consent/invitations/inv-expired/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mockBody),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).data.status).toBe('expired')
  })

  it('pending → sent 정상 (sent_at 채워짐)', async () => {
    mockChainsByIdx[0] = {
      result: {
        data: {
          id: 'inv-pending',
          user_id: 'user-abc',
          status: 'sent',
          sent_at: '2026-05-19T10:00:00.000Z',
          share_method: 'web_share',
        },
        error: null,
      },
    }
    mockBody = { status: 'sent', shareMethod: 'web_share' }

    const app = createApp()
    const res = await app.request('/api/consent/invitations/inv-pending/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mockBody),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('sent')
    expect(body.data.sent_at).toBeTruthy()
  })

  it('id/user_id 매칭 안 됨 → 404 (UPDATE 0 rows + SELECT fallback 도 0 rows)', async () => {
    mockChainsByIdx[0] = { result: { data: null, error: null } }
    mockChainsByIdx[1] = { result: { data: null, error: null } }
    mockBody = { status: 'sent' }

    const app = createApp()
    const res = await app.request('/api/consent/invitations/inv-nope/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mockBody),
    })

    expect(res.status).toBe(404)
  })

  it('잘못된 status (sent/opened 외) → 400', async () => {
    mockBody = { status: 'agreed' }
    const app = createApp()
    const res = await app.request('/api/consent/invitations/inv-x/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mockBody),
    })
    expect(res.status).toBe(400)
  })
})
