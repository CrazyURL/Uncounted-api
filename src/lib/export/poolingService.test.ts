import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase
vi.mock('../supabase.js', () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}))

import { supabaseAdmin } from '../supabase.js'

// Helper: create mock BU rows
function mockBU(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: `bu_${Math.random().toString(36).slice(2)}`,
    session_id: 'sess-1',
    minute_index: 0,
    user_id: 'user-1',
    quality_grade: 'A',
    qa_score: 80,
    quality_tier: 'verified',
    effective_seconds: 60,
    has_labels: true,
    consent_status: 'PUBLIC_CONSENTED',
    pii_status: 'CLEAR',
    lock_status: 'available',
    session_date: '2026-04-01',
    label_source: 'user_confirmed',
    ...overrides,
  }
}

// Helper: mock Supabase query chain — lazy proxy that resolves to { data, error }
function mockQueryChain(data: unknown[] | null, error: { message: string } | null = null) {
  const chainMethods = ['select', 'eq', 'in', 'gte', 'lte', 'order', 'range', 'limit', 'single']
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop: string) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve({ data, error })
      }
      if (chainMethods.includes(prop)) {
        return vi.fn().mockReturnValue(new Proxy({}, handler))
      }
      return undefined
    },
  }
  return new Proxy({}, handler)
}

describe('poolingService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('poolAndRankBUs', () => {
    it('selects BUs ranked by quality score', async () => {
      const buA = mockBU({ id: 'bu-a', qa_score: 90, user_id: 'u1' })
      const buB = mockBU({ id: 'bu-b', qa_score: 70, user_id: 'u2' })
      const buC = mockBU({ id: 'bu-c', qa_score: 50, user_id: 'u3' })

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'billable_units') return mockQueryChain([buA, buB, buC]) as never
        if (table === 'transcript_chunks') return mockQueryChain([
          { session_id: 'sess-1' },
        ]) as never
        if (table === 'bu_quality_metrics') return mockQueryChain([]) as never
        return mockQueryChain([]) as never
      })

      const { poolAndRankBUs } = await import('./poolingService.js')
      const result = await poolAndRankBUs('A01', 2)

      expect(result.selectedBUs).toHaveLength(2)
      expect(result.canFulfill).toBe(true)
      expect(result.shortfall).toBe(0)
      // Should be ranked by qaScore descending
      expect(result.selectedBUs[0].qaScore).toBeGreaterThanOrEqual(result.selectedBUs[1].qaScore)
    })

    it('reports shortfall when not enough BUs', async () => {
      const bu = mockBU({ id: 'bu-1', user_id: 'u1' })

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'billable_units') return mockQueryChain([bu]) as never
        if (table === 'transcript_chunks') return mockQueryChain([{ session_id: 'sess-1' }]) as never
        if (table === 'bu_quality_metrics') return mockQueryChain([]) as never
        return mockQueryChain([]) as never
      })

      const { poolAndRankBUs } = await import('./poolingService.js')
      const result = await poolAndRankBUs('A01', 10)

      expect(result.canFulfill).toBe(false)
      expect(result.shortfall).toBe(9)
      expect(result.available).toBe(1)
    })

    it('enforces speaker diversity constraint', async () => {
      // 5 BUs all from same speaker
      const bus = Array.from({ length: 5 }, (_, i) =>
        mockBU({ id: `bu-${i}`, user_id: 'same-user', qa_score: 90 - i * 5 }),
      )

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'billable_units') return mockQueryChain(bus) as never
        if (table === 'transcript_chunks') return mockQueryChain([{ session_id: 'sess-1' }]) as never
        if (table === 'bu_quality_metrics') return mockQueryChain([]) as never
        return mockQueryChain([]) as never
      })

      const { poolAndRankBUs } = await import('./poolingService.js')
      // Request 5, but maxSpeakerRatio=0.4 means max 2 from one speaker
      const result = await poolAndRankBUs('A01', 5, {}, {}, { maxSpeakerRatio: 0.4 })

      expect(result.selectedBUs.length).toBeLessThanOrEqual(2)
      expect(result.canFulfill).toBe(false)
    })
  })

  describe('previewPool', () => {
    it('returns summary statistics', async () => {
      const bus = [
        mockBU({ id: 'bu-1', user_id: 'u1', quality_grade: 'A', has_labels: true }),
        mockBU({ id: 'bu-2', user_id: 'u2', quality_grade: 'B', has_labels: false }),
      ]

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'billable_units') return mockQueryChain(bus) as never
        if (table === 'transcript_chunks') return mockQueryChain([{ session_id: 'sess-1' }]) as never
        if (table === 'bu_quality_metrics') return mockQueryChain([]) as never
        return mockQueryChain([]) as never
      })

      const { previewPool } = await import('./poolingService.js')
      const preview = await previewPool('A01')

      expect(preview.totalEligible).toBe(2)
      expect(preview.speakerCount).toBe(2)
      expect(preview.labelCoverage).toBe(0.5)
      expect(preview.qualityDistribution.A).toBe(1)
      expect(preview.qualityDistribution.B).toBe(1)
    })
  })
})

describe('inventoryService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns SKU-level inventory', async () => {
    const bus = [
      mockBU({ id: 'bu-1', user_id: 'u1', qa_score: 80, quality_grade: 'A' }),
      mockBU({ id: 'bu-2', user_id: 'u2', qa_score: 40, quality_grade: 'C' }),
    ]

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'billable_units') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: bus, error: null }),
          }),
        } as never
      }
      if (table === 'transcript_chunks') {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ data: [{ session_id: 'sess-1' }], error: null }),
          }),
        } as never
      }
      return { select: vi.fn().mockResolvedValue({ data: [], error: null }) } as never
    })

    const { getSkuInventory } = await import('./inventoryService.js')
    const inventory = await getSkuInventory()

    expect(inventory.totalAvailableBUs).toBe(2)
    expect(inventory.skus.length).toBeGreaterThan(0)
    expect(inventory.generatedAt).toBeTruthy()

    // A01 requires qa>=50, so only bu-1 qualifies
    const a01 = inventory.skus.find((s) => s.skuId === 'A01')
    expect(a01).toBeTruthy()
    expect(a01!.availableBUs).toBe(1)
  })
})
