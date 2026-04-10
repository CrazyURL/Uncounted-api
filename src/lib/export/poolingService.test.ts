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

    it('applies demographic targets - single category', async () => {
      // 6 BUs: 4 male, 2 female, request 4 with 50/50 gender target
      const bus = [
        mockBU({ id: 'bu-1', user_id: 'u1', qa_score: 95, session_id: 'sess-m1' }),
        mockBU({ id: 'bu-2', user_id: 'u2', qa_score: 90, session_id: 'sess-m2' }),
        mockBU({ id: 'bu-3', user_id: 'u3', qa_score: 85, session_id: 'sess-f1' }),
        mockBU({ id: 'bu-4', user_id: 'u4', qa_score: 80, session_id: 'sess-m3' }),
        mockBU({ id: 'bu-5', user_id: 'u5', qa_score: 75, session_id: 'sess-f2' }),
        mockBU({ id: 'bu-6', user_id: 'u6', qa_score: 70, session_id: 'sess-m4' }),
      ]

      // Mock users_profile data (user_id 기준)
      const profileData = [
        { user_id: 'u1', age_band: '30대', gender: '남성', region_group: '수도권' },
        { user_id: 'u2', age_band: '20대', gender: '남성', region_group: '영남' },
        { user_id: 'u3', age_band: '20대', gender: '여성', region_group: '수도권' },
        { user_id: 'u4', age_band: '40대', gender: '남성', region_group: '호남' },
        { user_id: 'u5', age_band: '30대', gender: '여성', region_group: '수도권' },
        { user_id: 'u6', age_band: '20대', gender: '남성', region_group: '영남' },
      ]

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'billable_units') return mockQueryChain(bus) as never
        if (table === 'transcript_chunks') return mockQueryChain([{ session_id: 'sess-m1' }, { session_id: 'sess-m2' }, { session_id: 'sess-f1' }, { session_id: 'sess-m3' }, { session_id: 'sess-f2' }, { session_id: 'sess-m4' }]) as never
        if (table === 'bu_quality_metrics') return mockQueryChain([]) as never
        if (table === 'users_profile') return mockQueryChain(profileData) as never
        return mockQueryChain([]) as never
      })

      const { poolAndRankBUs } = await import('./poolingService.js')
      const result = await poolAndRankBUs('A01', 4, {}, {}, {
        demographicTargets: {
          gender: { '남성': 0.5, '여성': 0.5 },
        },
      })

      // Should select 2 male + 2 female = 4 total
      const maleCount = result.selectedBUs.filter(bu => bu.gender === '남성').length
      const femaleCount = result.selectedBUs.filter(bu => bu.gender === '여성').length

      expect(result.selectedBUs).toHaveLength(4)
      expect(maleCount).toBe(2)
      expect(femaleCount).toBe(2)
      expect(result.demographicActual).toBeDefined()
      expect(result.demographicActual!.gender['남성']).toBe(0.5)
      expect(result.demographicActual!.gender['여성']).toBe(0.5)
    })

    it('reports demographic shortfall when targets cannot be met', async () => {
      // 3 BUs all male, request 4 with 50/50 gender target
      const bus = [
        mockBU({ id: 'bu-1', user_id: 'u1', qa_score: 95, session_id: 'sess-m1' }),
        mockBU({ id: 'bu-2', user_id: 'u2', qa_score: 90, session_id: 'sess-m2' }),
        mockBU({ id: 'bu-3', user_id: 'u3', qa_score: 85, session_id: 'sess-m3' }),
      ]

      const profileData = [
        { user_id: 'u1', age_band: '30대', gender: '남성', region_group: '수도권' },
        { user_id: 'u2', age_band: '20대', gender: '남성', region_group: '영남' },
        { user_id: 'u3', age_band: '40대', gender: '남성', region_group: '호남' },
      ]

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'billable_units') return mockQueryChain(bus) as never
        if (table === 'transcript_chunks') return mockQueryChain([{ session_id: 'sess-m1' }, { session_id: 'sess-m2' }, { session_id: 'sess-m3' }]) as never
        if (table === 'bu_quality_metrics') return mockQueryChain([]) as never
        if (table === 'users_profile') return mockQueryChain(profileData) as never
        return mockQueryChain([]) as never
      })

      const { poolAndRankBUs } = await import('./poolingService.js')
      const result = await poolAndRankBUs('A01', 4, {}, {}, {
        demographicTargets: {
          gender: { '남성': 0.5, '여성': 0.5 },
        },
      })

      // Male slots = 2, female slots = 2
      // Only 2 males can be selected (slot full), 0 females → shortfall
      expect(result.selectedBUs.length).toBeLessThanOrEqual(2)
      expect(result.canFulfill).toBe(false)
    })

    it('works without demographicTargets (backward compatible)', async () => {
      const bus = [
        mockBU({ id: 'bu-1', user_id: 'u1', qa_score: 90, session_id: 'sess-1' }),
        mockBU({ id: 'bu-2', user_id: 'u2', qa_score: 80, session_id: 'sess-1' }),
      ]

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'billable_units') return mockQueryChain(bus) as never
        if (table === 'transcript_chunks') return mockQueryChain([{ session_id: 'sess-1' }]) as never
        if (table === 'bu_quality_metrics') return mockQueryChain([]) as never
        if (table === 'users_profile') return mockQueryChain([]) as never
        return mockQueryChain([]) as never
      })

      const { poolAndRankBUs } = await import('./poolingService.js')
      const result = await poolAndRankBUs('A01', 2)

      expect(result.selectedBUs).toHaveLength(2)
      expect(result.demographicActual).toBeUndefined()
      expect(result.canFulfill).toBe(true)
    })

    it('applies multi-category demographic targets', async () => {
      // 6 BUs with mixed demographics
      const bus = [
        mockBU({ id: 'bu-1', user_id: 'u1', qa_score: 95, session_id: 'sess-1' }),
        mockBU({ id: 'bu-2', user_id: 'u2', qa_score: 90, session_id: 'sess-2' }),
        mockBU({ id: 'bu-3', user_id: 'u3', qa_score: 85, session_id: 'sess-3' }),
        mockBU({ id: 'bu-4', user_id: 'u4', qa_score: 80, session_id: 'sess-4' }),
        mockBU({ id: 'bu-5', user_id: 'u5', qa_score: 75, session_id: 'sess-5' }),
        mockBU({ id: 'bu-6', user_id: 'u6', qa_score: 70, session_id: 'sess-6' }),
      ]

      const profileData = [
        { user_id: 'u1', age_band: '20대', gender: '남성', region_group: '수도권' },
        { user_id: 'u2', age_band: '20대', gender: '여성', region_group: '수도권' },
        { user_id: 'u3', age_band: '30대', gender: '남성', region_group: '영남' },
        { user_id: 'u4', age_band: '30대', gender: '여성', region_group: '영남' },
        { user_id: 'u5', age_band: '20대', gender: '남성', region_group: '수도권' },
        { user_id: 'u6', age_band: '30대', gender: '여성', region_group: '호남' },
      ]

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'billable_units') return mockQueryChain(bus) as never
        if (table === 'transcript_chunks') return mockQueryChain(
          bus.map(b => ({ session_id: b.session_id }))
        ) as never
        if (table === 'bu_quality_metrics') return mockQueryChain([]) as never
        if (table === 'users_profile') return mockQueryChain(profileData) as never
        return mockQueryChain([]) as never
      })

      const { poolAndRankBUs } = await import('./poolingService.js')
      const result = await poolAndRankBUs('A01', 4, {}, {}, {
        demographicTargets: {
          gender: { '남성': 0.5, '여성': 0.5 },
          ageBand: { '20대': 0.5, '30대': 0.5 },
        },
      })

      expect(result.selectedBUs).toHaveLength(4)
      expect(result.demographicActual).toBeDefined()

      // Verify both categories achieved
      const males = result.selectedBUs.filter(bu => bu.gender === '남성').length
      const females = result.selectedBUs.filter(bu => bu.gender === '여성').length
      expect(males).toBe(2)
      expect(females).toBe(2)

      const twenties = result.selectedBUs.filter(bu => bu.ageBand === '20대').length
      const thirties = result.selectedBUs.filter(bu => bu.ageBand === '30대').length
      expect(twenties).toBe(2)
      expect(thirties).toBe(2)
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

    // U-A01 requires qa>=50, so only bu-1 qualifies
    const a01 = inventory.skus.find((s) => s.skuId === 'U-A01')
    expect(a01).toBeTruthy()
    expect(a01!.availableBUs).toBe(1)
  })
})
