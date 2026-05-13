// ── BM v10 단가/분배 정책 (STAGE 13) ────────────────────────────────────
//
// 회사 공식 정가는 시간당 ₩30,000 단일. SKU 차등 폐지 — 모든 통화·발화는
// 동일 정가로 계산. SKU 는 카테고리/라벨 분류용으로만 유지.
//
// App / Admin / 백엔드 정산 모두 이 상수를 import 해서 사용해야 한다.
// 직접 30000 하드코딩 금지.

export const HOURLY_RATE_KRW = 30_000

/** 통화 길이(초) → 정가 금액 (₩) */
export function priceForDurationKrw(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0
  return Math.round((durationSec * HOURLY_RATE_KRW) / 3600)
}

/** 통화 시간(시) → 정가 금액 (₩) */
export function priceForHoursKrw(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0
  return Math.round(hours * HOURLY_RATE_KRW)
}

// ── 50:50 분배 (사용자 / 플랫폼) ─────────────────────────────────────────
//
// BM v10 기본 분배 비율. 향후 settings 또는 delivery_profiles 테이블로 이전
// 가능. 현재는 코드 상수.

export const USER_SHARE_RATIO = 0.5
export const PLATFORM_SHARE_RATIO = 0.5

export interface RevenueShare {
  totalKrw: number
  userShareKrw: number
  platformShareKrw: number
}

/** 매출 분배 — 50:50 (홀수 ₩1 차이는 사용자에게 가산) */
export function splitRevenue(totalKrw: number): RevenueShare {
  if (!Number.isFinite(totalKrw) || totalKrw <= 0) {
    return { totalKrw: 0, userShareKrw: 0, platformShareKrw: 0 }
  }
  const platformShareKrw = Math.floor(totalKrw * PLATFORM_SHARE_RATIO)
  const userShareKrw = totalKrw - platformShareKrw
  return { totalKrw, userShareKrw, platformShareKrw }
}
