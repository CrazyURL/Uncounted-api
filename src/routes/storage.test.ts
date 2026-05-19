// ── POST /storage/raw-audio 업로드 테스트 ──────────────────────────────────
// 동의 완료 사용자가 raw audio를 업로드하는 전체 흐름 검증
// pre-check (Content-Type/Length) → 파싱 → DB → S3 순으로 테스트
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Supabase mock ─────────────────────────────────────────────────────────
// SELECT(idx=0)와 UPDATE(idx=1) 두 번의 from() 호출을 인덱스로 구분
let fromCallIdx = 0
const mockResultByIdx: Record<number, { data: any; error: any }> = {}

function getSupabaseResult(idx: number): { data: any; error: any } {
  if (idx in mockResultByIdx) return mockResultByIdx[idx]
  if (idx === 0) return { data: { id: 'session-001', raw_audio_url: null }, error: null }
  return { data: null, error: null }
}

vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: {
    from: (_table: string) => {
      const idx = fromCallIdx++
      const result = getSupabaseResult(idx)
      const chain: any = {
        select: () => chain,
        update: () => chain,
        eq: () => chain,
        single: () => Promise.resolve(result),
        then: (resolve: (v: any) => void, reject?: (e: any) => void) =>
          Promise.resolve(result).then(resolve, reject),
      }
      return chain
    },
  },
}))

// ── S3 mock ───────────────────────────────────────────────────────────────
const mockUploadObject = vi.fn().mockResolvedValue(undefined)
const mockObjectExists = vi.fn().mockResolvedValue(false)
const mockDeleteObjects = vi.fn().mockResolvedValue(undefined)

vi.mock('../lib/s3.js', () => ({
  uploadObject: (...args: any[]) => mockUploadObject(...args),
  objectExists: (...args: any[]) => mockObjectExists(...args),
  deleteObjects: (...args: any[]) => mockDeleteObjects(...args),
  listObjects: vi.fn().mockResolvedValue([]),
  getSignedUrl: vi.fn().mockResolvedValue('https://example.com/signed'),
  S3_AUDIO_BUCKET: 'audio-bucket',
  S3_META_BUCKET: 'meta-bucket',
}))

// ── Crypto mock: 테스트에서 평문 JSON을 meta로 직접 사용 ──────────────────
vi.mock('../lib/crypto.js', () => ({
  decryptData: (raw: string) => JSON.parse(raw),
  encryptData: (raw: any) => JSON.stringify(raw),
}))

// ── Middleware mock ───────────────────────────────────────────────────────
vi.mock('../lib/middleware.js', () => ({
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  getBody: vi.fn(() => ({})),
}))

// ── GPU worker mock (dynamic import) ─────────────────────────────────────
vi.mock('../services/gpu-worker.js', () => ({
  triggerWorker: vi.fn().mockResolvedValue(undefined),
}))

// ── App setup ─────────────────────────────────────────────────────────────
import { Hono } from 'hono'

const { default: storage } = await import('./storage.js')

function createApp() {
  const app = new Hono()
  app.use('/*', async (c, next) => {
    c.set('userId', 'user-abc')
    await next()
  })
  app.route('/api/storage', storage)
  return app
}

// ── buildMultipart: 실제 multipart/form-data 바이너리 구성 ────────────────
// 브라우저 Fetch API는 content-length 헤더를 수동 설정할 수 없으므로
// 테스트에서는 raw Uint8Array를 직접 만들어 Content-Length를 명시한다.
function buildMultipart(
  fields: Array<{ name: string; value: string | Uint8Array; filename?: string; type?: string }>,
) {
  const boundary = 'TestBoundary7890'
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const f of fields) {
    let hdr = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`
    if (f.filename) {
      hdr += `; filename="${f.filename}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}`
    }
    hdr += '\r\n\r\n'
    parts.push(enc.encode(hdr))
    parts.push(typeof f.value === 'string' ? enc.encode(f.value) : f.value)
    parts.push(enc.encode('\r\n'))
  }
  parts.push(enc.encode(`--${boundary}--\r\n`))
  const total = parts.reduce((a, p) => a + p.length, 0)
  const body = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    body.set(p, off)
    off += p.length
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, contentLength: total }
}

const META = JSON.stringify({ sessionId: 'session-001', ext: 'm4a' })
const SMALL_AUDIO = new Uint8Array([0xff, 0xf1, 0x50, 0x00, 0x01, 0x00]) // 6 bytes, m4a 헤더 모사

function makeValidMultipart() {
  return buildMultipart([
    { name: 'audioFile', value: SMALL_AUDIO, filename: 'test.m4a', type: 'audio/mp4' },
    { name: 'meta', value: META },
  ])
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe('POST /api/storage/raw-audio', () => {
  beforeEach(() => {
    fromCallIdx = 0
    for (const k of Object.keys(mockResultByIdx)) {
      delete mockResultByIdx[Number(k)]
    }
    mockUploadObject.mockClear()
    mockObjectExists.mockClear().mockResolvedValue(false)
    mockDeleteObjects.mockClear()
  })

  // ── Content-Type 사전 검사 (formData() 호출 전) ──────────────────────
  describe('Content-Type 사전 검사', () => {
    it('application/json → 415 (formData 미호출)', async () => {
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '10' },
        body: '{"a":1}',
      })
      expect(res.status).toBe(415)
      const json = await res.json() as { error: string }
      expect(json.error).toMatch(/content type/i)
    })

    it('Content-Type 없음 → 415', async () => {
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-length': '10' },
        body: 'body',
      })
      expect(res.status).toBe(415)
    })
  })

  // ── Content-Length 사전 검사 (formData() 호출 전) ────────────────────
  describe('Content-Length 사전 검사', () => {
    it('Content-Length 헤더 없음 → 411', async () => {
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=abc' },
        body: '--abc--',
      })
      expect(res.status).toBe(411)
    })

    it('Content-Length > 150MB → 413 (body를 실제로 버퍼링하지 않음)', async () => {
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=abc',
          'content-length': String(150 * 1024 * 1024 + 1),
        },
        body: '--abc--',
      })
      expect(res.status).toBe(413)
      const json = await res.json() as { error: string }
      expect(json.error).toMatch(/too large/i)
    })

    it('Content-Length = 숫자가 아닌 값 → 413', async () => {
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=abc',
          'content-length': 'not-a-number',
        },
        body: '--abc--',
      })
      expect(res.status).toBe(413)
    })

    it('Content-Length = 150MB (정확히) → 통과 (pre-check 경계값)', async () => {
      // pre-check는 통과하지만 실제 formData 파싱에서 실패할 수 있음 — 400/403 허용
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=abc',
          'content-length': String(150 * 1024 * 1024),
        },
        body: '--abc--',
      })
      expect(res.status).not.toBe(413)
      expect(res.status).not.toBe(411)
      expect(res.status).not.toBe(415)
    })
  })

  // ── 파싱 후 입력값 검사 ──────────────────────────────────────────────
  describe('파싱 후 입력값 검사', () => {
    it('audioFile 필드 없음 → 400', async () => {
      const mp = buildMultipart([{ name: 'meta', value: META }])
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': mp.contentType, 'content-length': String(mp.contentLength) },
        body: mp.body,
      })
      expect(res.status).toBe(400)
      const json = await res.json() as { error: string }
      expect(json.error).toMatch(/missing/i)
    })

    it('meta 필드 없음 → 400', async () => {
      const mp = buildMultipart([
        { name: 'audioFile', value: SMALL_AUDIO, filename: 'test.m4a', type: 'audio/mp4' },
      ])
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': mp.contentType, 'content-length': String(mp.contentLength) },
        body: mp.body,
      })
      expect(res.status).toBe(400)
    })

    it('허용되지 않은 확장자 (exe) → 400', async () => {
      const meta = JSON.stringify({ sessionId: 'session-001', ext: 'exe' })
      const mp = buildMultipart([
        { name: 'audioFile', value: SMALL_AUDIO, filename: 'virus.exe', type: 'application/octet-stream' },
        { name: 'meta', value: meta },
      ])
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': mp.contentType, 'content-length': String(mp.contentLength) },
        body: mp.body,
      })
      expect(res.status).toBe(400)
      const json = await res.json() as { error: string }
      expect(json.error).toMatch(/unsupported ext/i)
    })

    it('빈 파일 (0 bytes) → 400', async () => {
      const mp = buildMultipart([
        { name: 'audioFile', value: new Uint8Array(0), filename: 'empty.m4a', type: 'audio/mp4' },
        { name: 'meta', value: META },
      ])
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': mp.contentType, 'content-length': String(mp.contentLength) },
        body: mp.body,
      })
      expect(res.status).toBe(400)
      const json = await res.json() as { error: string }
      expect(json.error).toMatch(/empty/i)
    })
  })

  // ── 세션 소유권 · 중복 업로드 ─────────────────────────────────────────
  describe('세션 소유권 · 중복 업로드', () => {
    it('세션 없거나 타인 세션 → 403', async () => {
      mockResultByIdx[0] = { data: null, error: null }
      const mp = makeValidMultipart()
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': mp.contentType, 'content-length': String(mp.contentLength) },
        body: mp.body,
      })
      expect(res.status).toBe(403)
    })

    it('raw_audio_url 이미 있음 (중복 업로드) → 409', async () => {
      mockResultByIdx[0] = {
        data: { id: 'session-001', raw_audio_url: 'raw-audio/user-abc/session-001.m4a' },
        error: null,
      }
      const mp = makeValidMultipart()
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': mp.contentType, 'content-length': String(mp.contentLength) },
        body: mp.body,
      })
      expect(res.status).toBe(409)
    })
  })

  // ── Happy path ───────────────────────────────────────────────────────
  describe('정상 업로드', () => {
    it('200 + storagePath / sizeBytes 반환', async () => {
      const mp = makeValidMultipart()
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': mp.contentType, 'content-length': String(mp.contentLength) },
        body: mp.body,
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { storagePath: string; sizeBytes: number }
      expect(json.storagePath).toBe('raw-audio/user-abc/session-001.m4a')
      expect(json.sizeBytes).toBe(SMALL_AUDIO.byteLength)
    })

    it('S3 uploadObject 1회 호출 / audio/mp4 ContentType', async () => {
      const mp = makeValidMultipart()
      const app = createApp()
      await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': mp.contentType, 'content-length': String(mp.contentLength) },
        body: mp.body,
      })
      expect(mockUploadObject).toHaveBeenCalledOnce()
      expect(mockUploadObject).toHaveBeenCalledWith(
        'audio-bucket',
        'raw-audio/user-abc/session-001.m4a',
        expect.any(Uint8Array),
        'audio/mp4',
      )
    })

    it('wav 확장자 → audio/wav ContentType', async () => {
      const meta = JSON.stringify({ sessionId: 'session-001', ext: 'wav' })
      const mp = buildMultipart([
        { name: 'audioFile', value: SMALL_AUDIO, filename: 'test.wav', type: 'audio/wav' },
        { name: 'meta', value: meta },
      ])
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': mp.contentType, 'content-length': String(mp.contentLength) },
        body: mp.body,
      })
      expect(res.status).toBe(200)
      expect(mockUploadObject).toHaveBeenCalledWith(
        'audio-bucket',
        'raw-audio/user-abc/session-001.wav',
        expect.any(Uint8Array),
        'audio/wav',
      )
    })

    it('기존 S3 파일 있으면 삭제 후 재업로드', async () => {
      mockObjectExists.mockResolvedValueOnce(true)
      const mp = makeValidMultipart()
      const app = createApp()
      const res = await app.request('/api/storage/raw-audio', {
        method: 'POST',
        headers: { 'content-type': mp.contentType, 'content-length': String(mp.contentLength) },
        body: mp.body,
      })
      expect(res.status).toBe(200)
      expect(mockDeleteObjects).toHaveBeenCalledWith('audio-bucket', [
        'raw-audio/user-abc/session-001.m4a',
      ])
      expect(mockUploadObject).toHaveBeenCalledOnce()
    })
  })
})
