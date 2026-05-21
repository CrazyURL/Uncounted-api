import { describe, it, expect, vi, afterEach } from 'vitest'
import { detectBatch, toCandidateRows } from './candidateService.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('toCandidateRows — detect-batch 후보 → pii_candidates 행 매핑', () => {
  const candidates = [
    {
      type: '전화번호',
      char_start: 5,
      char_end: 18,
      confidence: 0.95,
      high_precision_pattern: true,
      confidence_tier: 'auto_confirmed' as const,
    },
    {
      type: '이름',
      char_start: 0,
      char_end: 3,
      confidence: 0.7,
      high_precision_pattern: false,
      confidence_tier: 'needs_human_decision' as const,
    },
  ]

  it('predicted_type/offset/tier 를 그대로 매핑한다', () => {
    const rows = toCandidateRows('u1', 's1', candidates, 'detect_spans_v1')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      utterance_id: 'u1',
      session_id: 's1',
      predicted_type: '전화번호',
      char_start: 5,
      char_end: 18,
      confidence: 0.95,
      high_precision_pattern: true,
      confidence_tier: 'auto_confirmed',
      model_version: 'detect_spans_v1',
      status: 'pending',
    })
  })

  it('행에 원문/matched_text 키가 없다 (원문 미저장 계약)', () => {
    const rows = toCandidateRows('u1', 's1', candidates, null)
    for (const r of rows) {
      expect(r).not.toHaveProperty('matched_text')
      expect(r).not.toHaveProperty('original_text')
      expect(r).not.toHaveProperty('text')
    }
  })

  it('빈 후보는 빈 행', () => {
    expect(toCandidateRows('u1', 's1', [], null)).toEqual([])
  })
})

describe('detectBatch — voice-api 호출', () => {
  it('items 를 /api/v1/pii/detect-batch 로 POST 하고 results 를 반환한다', async () => {
    const fakeResults = [{ utterance_id: 'u1', candidates: [] }]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: fakeResults }),
    })
    const out = await detectBatch(
      [{ utterance_id: 'u1', text: '안녕' }],
      { fetchImpl: fetchMock as unknown as typeof fetch, baseUrl: 'http://voice:8001' },
    )
    expect(out).toEqual(fakeResults)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://voice:8001/api/v1/pii/detect-batch')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body).items).toEqual([{ utterance_id: 'u1', text: '안녕' }])
  })

  it('비정상 응답이면 throw', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' })
    await expect(
      detectBatch([{ utterance_id: 'u1', text: 'x' }], {
        fetchImpl: fetchMock as unknown as typeof fetch,
        baseUrl: 'http://voice:8001',
      }),
    ).rejects.toThrow(/detect-batch/)
  })
})
