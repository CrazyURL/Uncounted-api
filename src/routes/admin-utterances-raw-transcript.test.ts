// ── PR-P2B-A: Admin 단일 발화 원문 전사 조회 라우트 테스트 ───────────────
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Supabase mock ─────────────────────────────────────────────────────
let mockRow: Record<string, unknown> | null = null
let mockErr: { message: string } | null = null

const mockSingle = vi.fn(() => Promise.resolve({ data: mockRow, error: mockErr }))
const mockEq = vi.fn(() => ({ single: mockSingle }))
const mockSelect = vi.fn(() => ({ eq: mockEq }))

vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: {
    from: (_table: string) => ({ select: mockSelect }),
  },
}))

// ── Middleware mock ───────────────────────────────────────────────────
// authMiddleware/adminMiddleware 만 통과 스텁으로 대체하고, devBodyLogger 는 실제 구현을
// 유지한다(스킵 동작을 실제로 검증하기 위함).
vi.mock('../lib/middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/middleware.js')>()
  return {
    ...actual,
    authMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
    adminMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  }
})

import { Hono } from 'hono'
import { devBodyLogger } from '../lib/middleware.js'

const { default: rawTranscriptRoute } = await import('./admin-utterances-raw-transcript.js')

function createApp() {
  const app = new Hono()
  app.route('/api/admin', rawTranscriptRoute)
  return app
}

beforeEach(() => {
  mockRow = null
  mockErr = null
  vi.clearAllMocks()
  mockSingle.mockImplementation(() => Promise.resolve({ data: mockRow, error: mockErr }))
  mockEq.mockReturnValue({ single: mockSingle })
  mockSelect.mockReturnValue({ eq: mockEq })
})

describe('GET /api/admin/utterances/:id/raw-transcript', () => {
  it('returns 200 with the raw transcript and minimal fields for an existing utterance', async () => {
    mockRow = { id: 'utt-1', session_id: 'sess-1', transcript_text: '안녕하세요 문식환 소장님' }
    const res = await createApp().request('/api/admin/utterances/utt-1/raw-transcript')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data).toEqual({
      utterance_id: 'utt-1',
      session_id: 'sess-1',
      transcript_text: '안녕하세요 문식환 소장님',
      length: '안녕하세요 문식환 소장님'.length,
    })
  })

  it('reports length as transcript_text.length (UTF-16 code units, matching server slice/extractSpan)', async () => {
    const text = '문 식 환 010-1234-5678'
    mockRow = { id: 'u', session_id: 's', transcript_text: text }
    const res = await createApp().request('/api/admin/utterances/u/raw-transcript')
    const json = await res.json()
    expect(json.data.length).toBe(text.length)
    // offset 정합성: data.transcript_text.slice(offset) 가 UI 선택과 같은 단위로 동작해야 한다.
    expect(json.data.transcript_text.slice(0, 1)).toBe('문')
  })

  it('returns no sensitive fields beyond the documented four', async () => {
    mockRow = { id: 'u', session_id: 's', transcript_text: 'x' }
    const res = await createApp().request('/api/admin/utterances/u/raw-transcript')
    const json = await res.json()
    expect(Object.keys(json.data).sort()).toEqual(
      ['length', 'session_id', 'transcript_text', 'utterance_id'].sort(),
    )
  })

  it('coerces null transcript_text to an empty string with length 0', async () => {
    mockRow = { id: 'u', session_id: 's', transcript_text: null }
    const res = await createApp().request('/api/admin/utterances/u/raw-transcript')
    const json = await res.json()
    expect(json.data.transcript_text).toBe('')
    expect(json.data.length).toBe(0)
  })

  it('sets Cache-Control: no-store so proxies/CDN/browser never cache raw PII', async () => {
    mockRow = { id: 'u', session_id: 's', transcript_text: 'secret' }
    const res = await createApp().request('/api/admin/utterances/u/raw-transcript')
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })

  it('returns 404 when the utterance does not exist', async () => {
    mockRow = null
    mockErr = { message: 'No rows found' }
    const res = await createApp().request('/api/admin/utterances/missing/raw-transcript')
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('utterance not found')
  })
})

describe('devBodyLogger never logs the raw transcript response', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  const prevEnv = process.env.NODE_ENV

  beforeEach(() => {
    process.env.NODE_ENV = 'development'
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
    process.env.NODE_ENV = prevEnv
  })

  function loggedApp() {
    const app = new Hono()
    app.use('/api/*', devBodyLogger)
    app.route('/api/admin', rawTranscriptRoute)
    // 같은 prefix 의 무관한 라우트 — 스킵이 표적형(전역 차단 아님)인지 검증용.
    app.get('/api/admin/sibling', (c) => c.json({ ok: true, marker: 'SIBLING_BODY' }))
    return app
  }

  it('skips the raw-transcript route (no console.log contains the transcript)', async () => {
    mockRow = { id: 'u', session_id: 's', transcript_text: 'SECRET_TRANSCRIPT_여보세요' }
    await loggedApp().request('/api/admin/utterances/u/raw-transcript')
    const loggedAnything = logSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('SECRET_TRANSCRIPT_여보세요')),
    )
    expect(loggedAnything).toBe(false)
  })

  it('still logs a sibling /api/admin route (skip is targeted, not a global break)', async () => {
    await loggedApp().request('/api/admin/sibling')
    const loggedSibling = logSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('SIBLING_BODY')),
    )
    expect(loggedSibling).toBe(true)
  })
})
