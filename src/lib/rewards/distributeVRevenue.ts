// ── BM v10.0 화자 보상 분배 알고리즘 v0.6 ──────────────────────────────
//
// 약관 v1.1 정합:
//   - 제11조 1항: 순이익 = 매출 - 운영비. 50% 회사 유보 + 50% 화자 풀.
//   - 제11조 2항: 선가입자 우선 (priority_index) + 시간 비례 분배.
//   - 제11조 3항: Cap ₩300만/년 + 매년 1월 1일 리셋.
//   - 제11조 4항: Cap 도달 시 잉여 데이터 자동 다음 v 이월.
//   - 제11조 5항: 매월 정산 + 22% 원천징수.
//
// 작동 흐름:
//   1. 분기 결산 (operating_cost_quarterly)에서 net_profit / speaker_pool 조회
//   2. 판매된 v별로 매출 비례 풀 산정
//   3. v별 contributor를 priority_index 정렬
//   4. 시간 비례 base_reward 계산
//   5. Cap 잔여 체크 → 잘리면 kept_data_pool 이월
//   6. user_reward_log 기록 (월별 정산 단위)

import { supabaseAdmin } from '../supabase.js'
import {
  YEARLY_CAP_KRW,
  WITHHOLDING_PCT,
  calculateNetPaid,
  currentFiscalYear,
  getYearlyRewardTotal,
} from './yearlyReward.js'

export type DistributeResult = {
  version_id: string
  sale_amount_krw: number
  speaker_pool_krw: number
  distributed_krw: number
  carry_over_krw: number
  rewards: RewardLine[]
  kept: KeptDataLine[]
}

export type RewardLine = {
  user_id: string
  amount_krw: number
  net_paid_krw: number
  cap_reached: boolean
}

export type KeptDataLine = {
  user_id: string
  utterance_count: number
  reason: 'cap_reached'
}

type ContributorRow = {
  user_id: string
  signup_at: string
  priority_index: number
  contributed_hours: number
}

type VersionRow = {
  version_id: string
  version_number: number
  total_hours: number
  status: string
}

/**
 * v 1건의 매출을 화자에게 분배.
 *
 * @param versionId data_versions.version_id
 * @param saleAmountKrw 본 v 1회 판매 매출 (KRW)
 * @param settledForMonth 정산 대상 월 (YYYY-MM-01 형식, 매월 말일 마감 단위)
 * @param fiscalYear 역년 (Cap 리셋 기준). undefined면 현재 역년.
 * @returns 분배 결과 요약
 */
export async function distributeVRevenue(
  versionId: string,
  saleAmountKrw: number,
  settledForMonth: string,
  fiscalYear?: number,
): Promise<DistributeResult> {
  if (saleAmountKrw <= 0) {
    throw new Error('saleAmountKrw must be positive')
  }
  const year = fiscalYear ?? currentFiscalYear()

  // 1. v 정보 조회
  const { data: version, error: vErr } = await supabaseAdmin
    .from('data_versions')
    .select('version_id, version_number, total_hours, status')
    .eq('version_id', versionId)
    .single<VersionRow>()
  if (vErr || !version) {
    throw new Error(`Version not found: ${versionId}`)
  }
  if (version.status !== 'sealed' && version.status !== 'sold') {
    throw new Error(
      `Version ${versionId} status=${version.status} — only sealed/sold can distribute`,
    )
  }

  // 2. 화자 풀 = 매출 × 50% (약관 v1.1 제11조 1항)
  // 운영비는 분기 결산 시점에 별도 차감 — 본 함수는 v 단건 매출 분배만 담당.
  // 실제 사용 시 admin-rewards 라우트에서 net_profit 계산 후 호출 권고.
  const speakerPool = Math.floor(saleAmountKrw * 0.5)

  // 3. contributor 정렬 (priority_index = 가입 순서)
  const { data: contributors, error: cErr } = await supabaseAdmin
    .from('version_contributors')
    .select('user_id, signup_at, priority_index, contributed_hours')
    .eq('version_id', versionId)
    .order('priority_index', { ascending: true })
    .returns<ContributorRow[]>()
  if (cErr) {
    throw new Error(`Failed to load contributors: ${cErr.message}`)
  }
  if (!contributors || contributors.length === 0) {
    throw new Error(`No contributors for version ${versionId}`)
  }

  // 4. 시간당 단가 (시간 비례 분배 입력)
  const unitValuePerHour = speakerPool / version.total_hours

  // 5. 선가입자 우선 + Cap 적용 + 잉여 이월 트리거
  const rewards: RewardLine[] = []
  const kept: KeptDataLine[] = []
  let remainingPool = speakerPool

  for (const c of contributors) {
    if (remainingPool <= 0) {
      // 풀 소진 — 나머지 contributor는 다음 v 이월 (구현 단순화: 본 함수는 로깅만)
      kept.push({
        user_id: c.user_id,
        utterance_count: 0, // 실제 utterance count는 별도 로직 (Sprint 3 #6)
        reason: 'cap_reached',
      })
      continue
    }

    const baseReward = Math.floor(c.contributed_hours * unitValuePerHour)
    const ytd = await getYearlyRewardTotal(c.user_id, year)
    const capRemaining = Math.max(YEARLY_CAP_KRW - ytd, 0)
    const actualReward = Math.min(baseReward, capRemaining, remainingPool)
    const capReached = ytd + actualReward >= YEARLY_CAP_KRW

    if (actualReward > 0) {
      const netPaid = calculateNetPaid(actualReward)
      const { error: insErr } = await supabaseAdmin.from('user_reward_log').insert({
        user_id: c.user_id,
        version_id: versionId,
        fiscal_year: year,
        amount_krw: actualReward,
        yearly_cap_at_time: YEARLY_CAP_KRW,
        yearly_cap_reached: capReached,
        withholding_pct: WITHHOLDING_PCT,
        net_paid_krw: netPaid,
        settled_for_month: settledForMonth,
      })
      if (insErr) {
        throw new Error(
          `Failed to log reward for ${c.user_id} v=${versionId}: ${insErr.message}`,
        )
      }
      rewards.push({
        user_id: c.user_id,
        amount_krw: actualReward,
        net_paid_krw: netPaid,
        cap_reached: capReached,
      })
      remainingPool -= actualReward
    }

    // Cap 도달 → 잉여 데이터 이월 마킹 (실제 utterance 매핑은 Sprint 3 #6)
    if (actualReward < baseReward) {
      kept.push({
        user_id: c.user_id,
        utterance_count: 0,
        reason: 'cap_reached',
      })
    }
  }

  // 6. v 판매 카운트 증가 + 신선도 재산정은 별도 트리거 (admin-rewards 라우트)

  return {
    version_id: versionId,
    sale_amount_krw: saleAmountKrw,
    speaker_pool_krw: speakerPool,
    distributed_krw: speakerPool - remainingPool,
    carry_over_krw: remainingPool,
    rewards,
    kept,
  }
}

/**
 * 분기 결산 입력 — operating_cost_quarterly에 매출 + 운영비 기록.
 * 약관 v1.1 제13조 6항 (분기 결산 공개) prerequisite.
 *
 * 본 함수는 admin-rewards 라우트에서 호출.
 */
export async function recordQuarterlyClosing(
  fiscalYear: number,
  quarter: number,
  fields: {
    revenue_krw: number
    cost_personnel: number
    cost_infrastructure: number
    cost_legal: number
    cost_marketing: number
    cost_speaker_acq: number
    cost_audit: number
    cost_other?: number
    cost_other_memo?: string
    non_operating_cost?: number
    non_operating_memo?: string
  },
): Promise<{ id: string; net_profit_krw: number; speaker_pool_krw: number }> {
  const { data, error } = await supabaseAdmin
    .from('operating_cost_quarterly')
    .upsert(
      {
        fiscal_year: fiscalYear,
        quarter,
        ...fields,
        cost_other: fields.cost_other ?? 0,
        non_operating_cost: fields.non_operating_cost ?? 0,
        closed_at: new Date().toISOString(),
      },
      { onConflict: 'fiscal_year,quarter' },
    )
    .select('id, net_profit_krw, speaker_pool_krw')
    .single<{ id: string; net_profit_krw: number; speaker_pool_krw: number }>()

  if (error || !data) {
    throw new Error(`recordQuarterlyClosing failed: ${error?.message}`)
  }
  return data
}

/**
 * 분기 결산 공개 (published_at 설정 — 사용자 대시보드 노출).
 * 약관 v1.1 제13조 6항: 분기 마감 후 30일 내 공개 의무.
 */
export async function publishQuarterlyClosing(
  fiscalYear: number,
  quarter: number,
  auditReportUrl?: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('operating_cost_quarterly')
    .update({
      published_at: new Date().toISOString(),
      audit_report_url: auditReportUrl ?? null,
    })
    .eq('fiscal_year', fiscalYear)
    .eq('quarter', quarter)

  if (error) {
    throw new Error(`publishQuarterlyClosing failed: ${error.message}`)
  }
}
