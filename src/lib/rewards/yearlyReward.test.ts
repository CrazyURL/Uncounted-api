// ── BM v10.0 yearlyReward — Cap 잔여 + 잉여 이월 단위 테스트 ───────────
import { describe, it, expect, vi, beforeEach } from 'vitest'

// supabaseAdmin mock (rpc + from)
const rpcMock = vi.fn()
vi.mock('../supabase.js', () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}))

import {
  YEARLY_CAP_KRW,
  WITHHOLDING_PCT,
  getYearlyRewardTotal,
  getCapRemaining,
  getCapProgress,
  calculateNetPaid,
  currentFiscalYear,
} from './yearlyReward.js'

describe('상수 정합 (약관 v1.1 제2조)', () => {
  it('YEARLY_CAP_KRW = ₩3,000,000 (한국 기타소득 분리과세 한도)', () => {
    expect(YEARLY_CAP_KRW).toBe(3_000_000)
  })

  it('WITHHOLDING_PCT = 22 (분리과세 6% + 부가세 등)', () => {
    expect(WITHHOLDING_PCT).toBe(22)
  })
})

describe('getYearlyRewardTotal — 역년 누적 보상 조회', () => {
  beforeEach(() => {
    rpcMock.mockReset()
  })

  it('rpc 결과가 number이면 그대로 반환', async () => {
    rpcMock.mockResolvedValueOnce({ data: 1_500_000, error: null })
    const total = await getYearlyRewardTotal('user-1', 2026)
    expect(total).toBe(1_500_000)
    expect(rpcMock).toHaveBeenCalledWith('user_yearly_reward_total', {
      p_user_id: 'user-1',
      p_fiscal_year: 2026,
      p_live_only: false,
    })
  })

  it('rpc 결과가 null이면 0', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null })
    const total = await getYearlyRewardTotal('user-2', 2026)
    expect(total).toBe(0)
  })

  it('rpc error 발생 시 throw', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'db down' } })
    await expect(getYearlyRewardTotal('user-3', 2026)).rejects.toThrow(/db down/)
  })
})

describe('getCapRemaining — Cap 잔여 계산', () => {
  beforeEach(() => {
    rpcMock.mockReset()
  })

  it('YTD < Cap이면 차이 반환', async () => {
    rpcMock.mockResolvedValueOnce({ data: 1_000_000, error: null })
    const remain = await getCapRemaining('user-1', 2026)
    expect(remain).toBe(2_000_000)
  })

  it('YTD == Cap이면 0', async () => {
    rpcMock.mockResolvedValueOnce({ data: 3_000_000, error: null })
    const remain = await getCapRemaining('user-1', 2026)
    expect(remain).toBe(0)
  })

  it('YTD > Cap이면 0 (음수 X — 약관 v1.1 정합)', async () => {
    rpcMock.mockResolvedValueOnce({ data: 5_000_000, error: null })
    const remain = await getCapRemaining('user-1', 2026)
    expect(remain).toBe(0)
  })
})

describe('getCapProgress — 사용자 대시보드 진행률', () => {
  beforeEach(() => {
    rpcMock.mockReset()
  })

  it('절반 진행 (₩1,500,000 / ₩3,000,000)', async () => {
    rpcMock.mockResolvedValueOnce({ data: 1_500_000, error: null })
    const p = await getCapProgress('user-1', 2026)
    expect(p.ytd_krw).toBe(1_500_000)
    expect(p.cap_krw).toBe(3_000_000)
    expect(p.remaining_krw).toBe(1_500_000)
    expect(p.progress_pct).toBe(50)
    expect(p.cap_reached).toBe(false)
  })

  it('Cap 도달 — progress_pct 100, cap_reached true', async () => {
    rpcMock.mockResolvedValueOnce({ data: 3_000_000, error: null })
    const p = await getCapProgress('user-1', 2026)
    expect(p.progress_pct).toBe(100)
    expect(p.cap_reached).toBe(true)
    expect(p.remaining_krw).toBe(0)
  })

  it('Cap 초과해도 progress_pct는 100으로 cap (UI 안전)', async () => {
    rpcMock.mockResolvedValueOnce({ data: 5_000_000, error: null })
    const p = await getCapProgress('user-1', 2026)
    expect(p.progress_pct).toBe(100)
  })
})

describe('calculateNetPaid — 22% 원천징수 후 실수령', () => {
  it('₩300만 → 78% = ₩234만', () => {
    expect(calculateNetPaid(3_000_000)).toBe(2_340_000)
  })

  it('₩100,000 → ₩78,000', () => {
    expect(calculateNetPaid(100_000)).toBe(78_000)
  })

  it('소수점 절사 (Math.floor)', () => {
    // 100 × 0.78 = 78
    expect(calculateNetPaid(100)).toBe(78)
    // 101 × 0.78 = 78.78 → 78
    expect(calculateNetPaid(101)).toBe(78)
  })

  it('0원 입력 시 0원', () => {
    expect(calculateNetPaid(0)).toBe(0)
  })
})

describe('currentFiscalYear — 매년 1월 1일 UTC 리셋', () => {
  it('현재 연도 반환 (UTC 기준)', () => {
    const year = currentFiscalYear()
    expect(year).toBe(new Date().getUTCFullYear())
  })

  it('연도가 4자리 정수', () => {
    const year = currentFiscalYear()
    expect(Number.isInteger(year)).toBe(true)
    expect(year).toBeGreaterThanOrEqual(2026)
  })
})
