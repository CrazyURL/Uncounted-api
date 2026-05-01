// ── BM v10.0 화자 보상 — 역년 Cap 잔여 + 잉여 이월 헬퍼 ────────────────
//
// 약관 v1.1 정합:
//   - 제2조: 연간 보상 Cap = ₩3,000,000 (한국 기타소득 분리과세 한도)
//   - 제11조 3항: 매년 1월 1일 자동 리셋
//   - 제11조 4항: Cap 도달 시 잉여 데이터 자동 다음 v 이월
//
// 본 모듈은 supabaseAdmin을 사용 (RLS 우회 — 분배 엔진 전용).

import { supabaseAdmin } from '../supabase.js'

// 약관 v1.1 제2조 정의 — 변경 시 약관·migration 045·세무사 자문 모두 갱신 필요
export const YEARLY_CAP_KRW = 3_000_000

// 22% 원천징수 (분리과세 6% + 부가세 등). 정확한 비율은 세무사 자문 후 확정.
export const WITHHOLDING_PCT = 22

/**
 * 사용자가 해당 역년에 누적 수령한 보상 합계 (KRW).
 * Cap 잔여 = YEARLY_CAP_KRW - 본 함수 결과.
 *
 * @param userId 사용자 UUID
 * @param fiscalYear 역년 (예: 2026)
 */
export async function getYearlyRewardTotal(
  userId: string,
  fiscalYear: number,
): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('user_yearly_reward_total', {
    p_user_id: userId,
    p_fiscal_year: fiscalYear,
  })
  if (error) {
    throw new Error(`getYearlyRewardTotal failed: ${error.message}`)
  }
  return Number(data ?? 0)
}

/**
 * Cap 잔여 — 본 역년에 추가로 수령 가능한 KRW.
 * 0 이하면 Cap 도달, 추가 분배 시 잉여 데이터 이월 처리.
 */
export async function getCapRemaining(
  userId: string,
  fiscalYear: number,
): Promise<number> {
  const ytd = await getYearlyRewardTotal(userId, fiscalYear)
  return Math.max(YEARLY_CAP_KRW - ytd, 0)
}

/**
 * 본인 역년 보상 진행률 (0.0 ~ 1.0).
 * 사용자 대시보드 표시용.
 */
export async function getCapProgress(
  userId: string,
  fiscalYear: number,
): Promise<{
  ytd_krw: number
  cap_krw: number
  remaining_krw: number
  progress_pct: number
  cap_reached: boolean
}> {
  const ytd = await getYearlyRewardTotal(userId, fiscalYear)
  const remaining = Math.max(YEARLY_CAP_KRW - ytd, 0)
  return {
    ytd_krw: ytd,
    cap_krw: YEARLY_CAP_KRW,
    remaining_krw: remaining,
    progress_pct: Math.min((ytd / YEARLY_CAP_KRW) * 100, 100),
    cap_reached: remaining === 0,
  }
}

/**
 * 22% 원천징수 후 실수령액 계산.
 */
export function calculateNetPaid(grossKrw: number): number {
  return Math.floor(grossKrw * (1 - WITHHOLDING_PCT / 100))
}

/**
 * 현재 역년 (UTC 기준).
 * 매년 1월 1일 00:00 UTC 자동 리셋.
 */
export function currentFiscalYear(): number {
  return new Date().getUTCFullYear()
}
