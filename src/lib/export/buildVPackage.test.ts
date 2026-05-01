// ── BM v10.0 buildVPackage — 4단계 SKU + v 빌더 단위 테스트 ────────────
import { describe, it, expect, vi, beforeEach } from 'vitest'

const versionData: { value: Record<string, unknown> | null } = { value: null }
const contributorCount: { value: number } = { value: 0 }
const lastVersionNumber: { value: number | null } = { value: null }
const insertedVersion: { value: { version_id: string; version_number: number } | null } = { value: null }
const updateError: { value: { message: string } | null } = { value: null }

vi.mock('../supabase.js', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'data_versions') {
        return {
          select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
            // createSeedV의 .eq('is_test_mode', ...).order().limit().maybeSingle() chain 호환
            const lastVersionResolver = {
              maybeSingle: async () => ({
                data: lastVersionNumber.value !== null
                  ? { version_number: lastVersionNumber.value }
                  : null,
                error: null,
              }),
            }
            return {
              eq: () => ({
                single: async () => ({
                  data: versionData.value,
                  error: versionData.value ? null : { message: 'not found' },
                }),
                // createSeedV chain: .eq().order().limit().maybeSingle()
                order: () => ({
                  limit: () => lastVersionResolver,
                }),
              }),
              order: () => ({
                limit: () => lastVersionResolver,
              }),
              // count: 'exact' head: true 패턴은 select 직접 호출
              ...(opts?.count === 'exact' && opts?.head ? {
                eq: () => ({
                  count: contributorCount.value,
                  error: null,
                  then: (resolve: (v: unknown) => void) =>
                    resolve({ count: contributorCount.value, error: null }),
                }),
              } : {}),
            }
          },
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: insertedVersion.value,
                error: insertedVersion.value ? null : { message: 'insert fail' },
              }),
            }),
          }),
          update: () => ({
            eq: async () => ({ error: updateError.value }),
          }),
        }
      }
      if (table === 'version_contributors') {
        // count: 'exact' head: true 패턴
        return {
          select: () => ({
            eq: async () => ({
              count: contributorCount.value,
              error: null,
            }),
          }),
        }
      }
      throw new Error(`Unmocked table: ${table}`)
    },
  },
}))

import {
  SKU_TIER_SPECS,
  recommendSkuTier,
  validateVSize,
  buildVManifest,
  recordVSale,
  createSeedV,
} from './buildVPackage.js'

beforeEach(() => {
  versionData.value = null
  contributorCount.value = 0
  lastVersionNumber.value = null
  insertedVersion.value = null
  updateError.value = null
})

describe('SKU_TIER_SPECS — 약관 v1.1 제10조 2항 정합', () => {
  it('UC-A1 시드 6h, UC-A2 60h, UC-A3 6,000h, UC-LLM 6,000h', () => {
    expect(SKU_TIER_SPECS['UC-A1'].standardHours).toBe(6)
    expect(SKU_TIER_SPECS['UC-A2'].standardHours).toBe(60)
    expect(SKU_TIER_SPECS['UC-A3'].standardHours).toBe(6_000)
    expect(SKU_TIER_SPECS['UC-LLM'].standardHours).toBe(6_000)
  })

  it('비독점 N회 상한 — A1=1회, A2=6회, A3·LLM=10회', () => {
    expect(SKU_TIER_SPECS['UC-A1'].maxSoldCount).toBe(1)
    expect(SKU_TIER_SPECS['UC-A2'].maxSoldCount).toBe(6)
    expect(SKU_TIER_SPECS['UC-A3'].maxSoldCount).toBe(10)
    expect(SKU_TIER_SPECS['UC-LLM'].maxSoldCount).toBe(10)
  })
})

describe('recommendSkuTier — 가입자 수 + 누적 시간 → 적정 단계', () => {
  it('가입자 50명 + 5h → UC-A1 (시드)', () => {
    expect(recommendSkuTier(50, 5)).toBe('UC-A1')
  })

  it('가입자 500명 + 80h → UC-A2 (트라이얼)', () => {
    expect(recommendSkuTier(500, 80)).toBe('UC-A2')
  })

  it('가입자 50,000명 + 1,000h → UC-A2 (정기 기준 미달이라 A2)', () => {
    expect(recommendSkuTier(50_000, 1_000)).toBe('UC-A2')
  })

  it('가입자 200,000명 + 7,000h → UC-A3 (규모)', () => {
    expect(recommendSkuTier(200_000, 7_000)).toBe('UC-A3')
  })

  it('가입자 부족하면 UC-A1로 fallback', () => {
    expect(recommendSkuTier(10, 6_000)).toBe('UC-A1')
  })
})

describe('validateVSize — SKU별 표준 단위 검증', () => {
  it('UC-A1 시드: 1~10h 허용', () => {
    expect(validateVSize('UC-A1', 6).valid).toBe(true)
    expect(validateVSize('UC-A1', 1).valid).toBe(true)
    expect(validateVSize('UC-A1', 10).valid).toBe(true)
    expect(validateVSize('UC-A1', 0.5).valid).toBe(false)
    expect(validateVSize('UC-A1', 11).valid).toBe(false)
  })

  it('UC-A2: 60h±10% 또는 600h±10%', () => {
    expect(validateVSize('UC-A2', 60).valid).toBe(true)
    expect(validateVSize('UC-A2', 54).valid).toBe(true)  // -10%
    expect(validateVSize('UC-A2', 66).valid).toBe(true)  // +10%
    expect(validateVSize('UC-A2', 600).valid).toBe(true)
    expect(validateVSize('UC-A2', 540).valid).toBe(true)  // -10%
    expect(validateVSize('UC-A2', 660).valid).toBe(true)  // +10%
    expect(validateVSize('UC-A2', 100).valid).toBe(false)  // 60·600 사이 빈 구간
  })

  it('UC-A3: 6,000h±10%', () => {
    expect(validateVSize('UC-A3', 6_000).valid).toBe(true)
    expect(validateVSize('UC-A3', 5_400).valid).toBe(true)
    expect(validateVSize('UC-A3', 6_600).valid).toBe(true)
    expect(validateVSize('UC-A3', 5_000).valid).toBe(false)
    expect(validateVSize('UC-A3', 7_000).valid).toBe(false)
  })

  it('UC-LLM: 6,000h±10%', () => {
    expect(validateVSize('UC-LLM', 6_000).valid).toBe(true)
    expect(validateVSize('UC-LLM', 5_400).valid).toBe(true)
  })
})

describe('buildVManifest — v export root 메타', () => {
  it('정상 v sealed 상태 → manifest 반환 (신선도 1 = 프리미엄)', async () => {
    versionData.value = {
      version_id: 'v-uuid-1',
      version_number: 1,
      cohort_period_start: '2026-01-01T00:00:00Z',
      cohort_period_end: '2026-04-30T23:59:59Z',
      total_hours: 600,
      freshness_quartile: 1,
      status: 'sealed',
      sku_tier: 'UC-A2',
      family_pct: 30.0,
      friend_pct: 30.0,
      business_pct: 40.0,
      sold_count: 0,
      max_sold_count: 6,
    }
    contributorCount.value = 12

    const manifest = await buildVManifest('v-uuid-1', 'buyer-A')

    expect(manifest.schemaVersion).toBe('2.0')
    expect(manifest.versionNumber).toBe(1)
    expect(manifest.skuTier).toBe('UC-A2')
    expect(manifest.buyerId).toBe('buyer-A')
    expect(manifest.cohort.totalHours).toBe(600)
    expect(manifest.cohort.contributorCount).toBe(12)
    expect(manifest.cohort.familyPct).toBe(30.0)
    expect(manifest.freshness.quartile).toBe(1)
    expect(manifest.freshness.label).toBe('최신 (프리미엄)')
    expect(manifest.exclusivity.maxSoldCount).toBe(6)
    expect(manifest.exclusivity.remainingSlots).toBe(6)
    expect(manifest.distributionAlgorithm.version).toBe('v0.6')
  })

  it('v 사이즈 검증 실패 시 throw', async () => {
    versionData.value = {
      version_id: 'v-bad',
      version_number: 1,
      cohort_period_start: '2026-01-01T00:00:00Z',
      cohort_period_end: '2026-04-30T23:59:59Z',
      total_hours: 100,  // UC-A2 60·600 사이 빈 구간
      freshness_quartile: 1,
      status: 'sealed',
      sku_tier: 'UC-A2',
      sold_count: 0,
      max_sold_count: 6,
    }
    await expect(buildVManifest('v-bad', null)).rejects.toThrow(/v size 검증 실패/)
  })

  it('version not found 시 throw', async () => {
    versionData.value = null
    await expect(buildVManifest('missing', null)).rejects.toThrow(/Version not found/)
  })

  it('freshness quartile 4 = 오래 (할인) label', async () => {
    versionData.value = {
      version_id: 'v-old',
      version_number: 10,
      cohort_period_start: '2024-01-01T00:00:00Z',
      cohort_period_end: '2024-06-30T23:59:59Z',
      total_hours: 600,
      freshness_quartile: 4,
      status: 'sold',
      sku_tier: 'UC-A2',
      sold_count: 5,
      max_sold_count: 6,
    }
    contributorCount.value = 100

    const manifest = await buildVManifest('v-old', null)
    expect(manifest.freshness.quartile).toBe(4)
    expect(manifest.freshness.label).toBe('오래 (할인)')
    expect(manifest.exclusivity.remainingSlots).toBe(1)
  })
})

describe('createSeedV — 시드 단계 v 즉시 생성', () => {
  it('UC-A1 6h → version_number 1로 생성', async () => {
    lastVersionNumber.value = null  // 첫 v
    insertedVersion.value = { version_id: 'v-seed-1', version_number: 1 }

    const r = await createSeedV({
      totalHours: 6,
      skuTier: 'UC-A1',
      cohortPeriodStart: '2026-05-01T00:00:00Z',
      cohortPeriodEnd: '2026-05-15T00:00:00Z',
    })
    expect(r.versionNumber).toBe(1)
    expect(r.versionId).toBe('v-seed-1')
  })

  it('UC-A1 잘못된 사이즈 → throw', async () => {
    await expect(
      createSeedV({
        totalHours: 100,
        skuTier: 'UC-A1',
        cohortPeriodStart: '2026-05-01T00:00:00Z',
        cohortPeriodEnd: '2026-05-15T00:00:00Z',
      }),
    ).rejects.toThrow(/createSeedV size 검증 실패/)
  })

  it('이전 v 존재 시 +1 증가', async () => {
    lastVersionNumber.value = 5
    insertedVersion.value = { version_id: 'v-seed-6', version_number: 6 }

    const r = await createSeedV({
      totalHours: 6,
      skuTier: 'UC-A1',
      cohortPeriodStart: '2026-06-01T00:00:00Z',
      cohortPeriodEnd: '2026-06-15T00:00:00Z',
    })
    expect(r.versionNumber).toBe(6)
  })
})
