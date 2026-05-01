// ── BM v10.0 distributeVRevenue — 핵심 분배 알고리즘 v0.6 단위 테스트 ──
import { describe, it, expect, vi, beforeEach } from 'vitest'

// supabaseAdmin mock — chainable query builder
const versionData: { value: { version_id: string; version_number: number; total_hours: number; status: string } | null } = { value: null }
const contributorsData: { value: Array<{ user_id: string; signup_at: string; priority_index: number; contributed_hours: number }> } = { value: [] }
const insertedRewards: Array<Record<string, unknown>> = []
const rpcReturnsByUser: Record<string, number> = {}
const upsertReturn: { value: { id: string; net_profit_krw: number; speaker_pool_krw: number } | null } = { value: null }
const updateError: { value: { message: string } | null } = { value: null }

vi.mock('../supabase.js', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'data_versions') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: versionData.value,
                error: versionData.value ? null : { message: 'not found' },
              }),
            }),
          }),
        }
      }
      if (table === 'version_contributors') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                returns: () => ({
                  data: contributorsData.value,
                  error: null,
                  then: (resolve: (v: unknown) => void) =>
                    resolve({ data: contributorsData.value, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'user_reward_log') {
        return {
          insert: async (row: Record<string, unknown>) => {
            insertedRewards.push(row)
            return { data: null, error: null }
          },
        }
      }
      if (table === 'operating_cost_quarterly') {
        return {
          upsert: () => ({
            select: () => ({
              single: async () => ({
                data: upsertReturn.value,
                error: upsertReturn.value ? null : { message: 'upsert fail' },
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: async () => ({ error: updateError.value }),
            }),
          }),
        }
      }
      throw new Error(`Unmocked table: ${table}`)
    },
    rpc: async (_fn: string, args: { p_user_id: string }) => ({
      data: rpcReturnsByUser[args.p_user_id] ?? 0,
      error: null,
    }),
  },
}))

import {
  distributeVRevenue,
  recordQuarterlyClosing,
  publishQuarterlyClosing,
} from './distributeVRevenue.js'

beforeEach(() => {
  versionData.value = null
  contributorsData.value = []
  insertedRewards.length = 0
  for (const k of Object.keys(rpcReturnsByUser)) delete rpcReturnsByUser[k]
  upsertReturn.value = null
  updateError.value = null
})

describe('distributeVRevenue — 입력 검증', () => {
  it('saleAmountKrw <= 0이면 throw', async () => {
    await expect(
      distributeVRevenue('v-1', 0, '2026-05-01'),
    ).rejects.toThrow(/saleAmountKrw must be positive/)
  })

  it('version not found이면 throw', async () => {
    versionData.value = null
    await expect(
      distributeVRevenue('missing', 1_000_000, '2026-05-01'),
    ).rejects.toThrow(/Version not found/)
  })

  it('version status가 pending이면 throw (sealed/sold만 분배)', async () => {
    versionData.value = {
      version_id: 'v-1',
      version_number: 1,
      total_hours: 600,
      status: 'pending',
    }
    contributorsData.value = [
      { user_id: 'u-1', signup_at: '2026-01-01', priority_index: 1, contributed_hours: 80 },
    ]
    await expect(
      distributeVRevenue('v-1', 1_000_000, '2026-05-01'),
    ).rejects.toThrow(/only sealed\/sold/)
  })
})

describe('distributeVRevenue — 핵심 분배 (선가입자 우선 + 시간 비례)', () => {
  it('Cap 미달 — 시간 비례 분배 + 화자 풀 50%', async () => {
    versionData.value = {
      version_id: 'v-1',
      version_number: 1,
      total_hours: 600,
      status: 'sealed',
    }
    contributorsData.value = [
      { user_id: 'u-1', signup_at: '2026-01-01', priority_index: 1, contributed_hours: 80 },
      { user_id: 'u-2', signup_at: '2026-01-02', priority_index: 2, contributed_hours: 50 },
    ]

    // 매출 ₩6,000,000 → 화자 풀 ₩3,000,000
    // 시간당 = 3,000,000 / 600 = 5,000
    // u-1: 80h × 5,000 = ₩400,000 (Cap 잔여 충분)
    // u-2: 50h × 5,000 = ₩250,000

    const result = await distributeVRevenue('v-1', 6_000_000, '2026-05-01', 2026)

    expect(result.speaker_pool_krw).toBe(3_000_000)
    expect(result.rewards).toHaveLength(2)
    expect(result.rewards[0].user_id).toBe('u-1')
    expect(result.rewards[0].amount_krw).toBe(400_000)
    expect(result.rewards[0].cap_reached).toBe(false)
    expect(result.rewards[1].user_id).toBe('u-2')
    expect(result.rewards[1].amount_krw).toBe(250_000)
    expect(result.distributed_krw).toBe(650_000)
    expect(result.carry_over_krw).toBe(2_350_000)  // 풀 잔여
    expect(insertedRewards).toHaveLength(2)
  })

  it('Cap 도달 — 분배 자르고 잉여 마킹', async () => {
    versionData.value = {
      version_id: 'v-1',
      version_number: 1,
      total_hours: 600,
      status: 'sealed',
    }
    contributorsData.value = [
      { user_id: 'u-heavy', signup_at: '2026-01-01', priority_index: 1, contributed_hours: 600 },
    ]
    // 이미 ₩2,800,000 수령 → Cap 잔여 ₩200,000
    rpcReturnsByUser['u-heavy'] = 2_800_000

    // 매출 ₩6,000,000 → 화자 풀 ₩3,000,000
    // 시간당 = 5,000
    // u-heavy base = 600 × 5,000 = ₩3,000,000 (큰 차이)
    // Cap 잔여 ₩200,000만 분배, 나머지 ₩2,800,000은 잉여 이월

    const result = await distributeVRevenue('v-1', 6_000_000, '2026-05-01', 2026)

    expect(result.rewards).toHaveLength(1)
    expect(result.rewards[0].amount_krw).toBe(200_000)
    expect(result.rewards[0].cap_reached).toBe(true)
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0].user_id).toBe('u-heavy')
    expect(result.kept[0].reason).toBe('cap_reached')
  })

  it('선가입자 우선 — priority_index 1이 먼저 분배 받음', async () => {
    versionData.value = {
      version_id: 'v-1',
      version_number: 1,
      total_hours: 600,
      status: 'sealed',
    }
    contributorsData.value = [
      // 의도적으로 정렬 안 된 상태로 mock 반환 (실제로는 query order로 정렬됨)
      { user_id: 'u-first', signup_at: '2026-01-01', priority_index: 1, contributed_hours: 100 },
      { user_id: 'u-second', signup_at: '2026-01-15', priority_index: 2, contributed_hours: 100 },
    ]

    const result = await distributeVRevenue('v-1', 1_200_000, '2026-05-01', 2026)

    expect(result.rewards[0].user_id).toBe('u-first')
    expect(result.rewards[1].user_id).toBe('u-second')
  })

  it('22% 원천징수 후 net_paid_krw 정확', async () => {
    versionData.value = {
      version_id: 'v-1',
      version_number: 1,
      total_hours: 600,
      status: 'sealed',
    }
    contributorsData.value = [
      { user_id: 'u-1', signup_at: '2026-01-01', priority_index: 1, contributed_hours: 600 },
    ]

    // 매출 ₩1,200,000 → 풀 ₩600,000 → u-1 ₩600,000
    // 22% 원천징수 → 실수령 ₩468,000

    const result = await distributeVRevenue('v-1', 1_200_000, '2026-05-01', 2026)
    expect(result.rewards[0].amount_krw).toBe(600_000)
    expect(result.rewards[0].net_paid_krw).toBe(468_000)
  })
})

describe('recordQuarterlyClosing — 분기 결산 입력', () => {
  it('GENERATED net_profit + speaker_pool 반환', async () => {
    upsertReturn.value = {
      id: 'q-1',
      net_profit_krw: 30_000_000,
      speaker_pool_krw: 15_000_000,
    }
    const r = await recordQuarterlyClosing(2026, 1, {
      revenue_krw: 50_000_000,
      cost_personnel: 15_000_000,
      cost_infrastructure: 3_000_000,
      cost_legal: 1_000_000,
      cost_marketing: 500_000,
      cost_speaker_acq: 500_000,
      cost_audit: 0,
    })
    expect(r.net_profit_krw).toBe(30_000_000)
    expect(r.speaker_pool_krw).toBe(15_000_000)
  })

  it('upsert error 시 throw', async () => {
    upsertReturn.value = null
    await expect(
      recordQuarterlyClosing(2026, 1, {
        revenue_krw: 0,
        cost_personnel: 0,
        cost_infrastructure: 0,
        cost_legal: 0,
        cost_marketing: 0,
        cost_speaker_acq: 0,
        cost_audit: 0,
      }),
    ).rejects.toThrow(/recordQuarterlyClosing failed/)
  })
})

describe('publishQuarterlyClosing — 분기 결산 공개 (제13조 6항)', () => {
  it('정상 update 시 throw 없음', async () => {
    updateError.value = null
    await expect(
      publishQuarterlyClosing(2026, 1, 'https://audit.example.com/2026Q1.pdf'),
    ).resolves.toBeUndefined()
  })

  it('update error 시 throw', async () => {
    updateError.value = { message: 'rls denied' }
    await expect(publishQuarterlyClosing(2026, 1)).rejects.toThrow(/rls denied/)
  })
})
