// ── Admin Rewards Routes — BM v10.0 분배 운영 ──────────────────────────
//
// 약관 v1.1 정합:
//   - 제11조: 분배 알고리즘 v0.6 트리거
//   - 제13조 6항: 분기 운영비 결산 입력 + 공개
//   - 제18조: 운영비 정의 (통상 사업비 + 비통상 분리)
//
// 권한: admin only (admin-ledger 패턴 동일)

import { Hono } from 'hono'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import {
  distributeVRevenue,
  recordQuarterlyClosing,
  publishQuarterlyClosing,
} from '../lib/rewards/distributeVRevenue.js'
import { supabaseAdmin } from '../lib/supabase.js'

const adminRewards = new Hono()

adminRewards.use('/*', authMiddleware)
adminRewards.use('/*', adminMiddleware)

// ── 분기 결산 입력 (운영비 + 매출) ──────────────────────────────────────
// POST /api/admin/rewards/quarterly-closing
//
// body: {
//   fiscal_year: 2026, quarter: 1,
//   revenue_krw: 360000000,
//   cost_personnel: 20000000, cost_infrastructure: 5000000, ...
// }
adminRewards.post('/rewards/quarterly-closing', async (c) => {
  const body = getBody<{
    fiscal_year: number
    quarter: number
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
  }>(c)

  if (!body?.fiscal_year || !body?.quarter) {
    return c.json({ error: 'fiscal_year, quarter required' }, 400)
  }
  if (body.quarter < 1 || body.quarter > 4) {
    return c.json({ error: 'quarter must be 1~4' }, 400)
  }
  if (typeof body.revenue_krw !== 'number' || body.revenue_krw < 0) {
    return c.json({ error: 'revenue_krw required and >= 0' }, 400)
  }

  try {
    const result = await recordQuarterlyClosing(body.fiscal_year, body.quarter, {
      revenue_krw: body.revenue_krw,
      cost_personnel: body.cost_personnel ?? 0,
      cost_infrastructure: body.cost_infrastructure ?? 0,
      cost_legal: body.cost_legal ?? 0,
      cost_marketing: body.cost_marketing ?? 0,
      cost_speaker_acq: body.cost_speaker_acq ?? 0,
      cost_audit: body.cost_audit ?? 0,
      cost_other: body.cost_other,
      cost_other_memo: body.cost_other_memo,
      non_operating_cost: body.non_operating_cost,
      non_operating_memo: body.non_operating_memo,
    })
    return c.json({ data: result })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

// ── 분기 결산 공개 (사용자 대시보드 노출) ───────────────────────────────
// POST /api/admin/rewards/quarterly-publish
// 약관 v1.1 제13조 6항: 분기 마감 후 30일 내 공개 의무.
adminRewards.post('/rewards/quarterly-publish', async (c) => {
  const body = getBody<{
    fiscal_year: number
    quarter: number
    audit_report_url?: string
  }>(c)

  if (!body?.fiscal_year || !body?.quarter) {
    return c.json({ error: 'fiscal_year, quarter required' }, 400)
  }

  try {
    await publishQuarterlyClosing(body.fiscal_year, body.quarter, body.audit_report_url)
    return c.json({ data: { published: true } })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

// ── v 매출 분배 트리거 ──────────────────────────────────────────────────
// POST /api/admin/rewards/distribute
// body: { version_id, sale_amount_krw, settled_for_month }
//
// 약관 v1.1 제11조: 매출 × 50% 화자 풀 → 선가입자 우선 + Cap + 잉여 이월
adminRewards.post('/rewards/distribute', async (c) => {
  const body = getBody<{
    version_id: string
    sale_amount_krw: number
    settled_for_month: string  // YYYY-MM-01
    fiscal_year?: number
  }>(c)

  if (!body?.version_id || !body?.sale_amount_krw || !body?.settled_for_month) {
    return c.json({
      error: 'version_id, sale_amount_krw, settled_for_month required',
    }, 400)
  }

  try {
    const result = await distributeVRevenue(
      body.version_id,
      body.sale_amount_krw,
      body.settled_for_month,
      body.fiscal_year,
    )
    return c.json({ data: result })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

// ── 분기 결산 조회 (admin 전용 — 미공개 결산 포함) ──────────────────────
adminRewards.get('/rewards/quarterly-closings', async (c) => {
  const fiscalYear = c.req.query('fiscal_year')

  let query = supabaseAdmin
    .from('operating_cost_quarterly')
    .select('*')
    .order('fiscal_year', { ascending: false })
    .order('quarter', { ascending: false })

  if (fiscalYear) {
    query = query.eq('fiscal_year', Number(fiscalYear))
  }

  const { data, error } = await query
  if (error) {
    return c.json({ error: error.message }, 500)
  }
  return c.json({ data })
})

export default adminRewards
