// ── User Rewards Routes — BM v10.0 본인 보상 조회 ──────────────────────
//
// 약관 v1.1 정합:
//   - 제11조 3항: Cap ₩300만/년 + 매년 1월 리셋
//   - 제11조 4항: 잉여 데이터 자동 이월
//   - 제13조 5항: 분배 알고리즘 투명 공개
//
// 사용자 본인 데이터만 조회 (RLS + authMiddleware로 user_id 일치 검증).

import { Hono } from 'hono'
import { authMiddleware } from '../lib/middleware.js'
import {
  getCapProgress,
  currentFiscalYear,
} from '../lib/rewards/yearlyReward.js'
import { supabaseAdmin } from '../lib/supabase.js'

const userRewards = new Hono()

userRewards.use('/*', authMiddleware)

// ── 본인 Cap 진행률 + 누적 보상 ─────────────────────────────────────────
// GET /api/user/rewards/cap-progress?fiscal_year=2026&live_only=true
//
// live_only=true (기본): is_test_mode=false만 합산 (DEV 토글 보상 제외).
// live_only=false: 전체 합산 (admin 검증용).
userRewards.get('/rewards/cap-progress', async (c) => {
  const userId = c.get('userId')
  if (!userId) {
    return c.json({ error: 'unauthenticated' }, 401)
  }
  const fiscalYear = Number(c.req.query('fiscal_year') ?? currentFiscalYear())
  // live_only 기본 true (사용자 대시보드는 live 데이터만 보여줌)
  const liveOnly = c.req.query('live_only') !== 'false'

  try {
    const progress = await getCapProgress(userId, fiscalYear, liveOnly)
    return c.json({ data: { fiscal_year: fiscalYear, ...progress } })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

// ── 본인 보상 지급 내역 (월별/v별) ──────────────────────────────────────
// GET /api/user/rewards/log?fiscal_year=2026&limit=50&live_only=true
userRewards.get('/rewards/log', async (c) => {
  const userId = c.get('userId')
  if (!userId) {
    return c.json({ error: 'unauthenticated' }, 401)
  }
  const fiscalYear = c.req.query('fiscal_year')
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)
  const liveOnly = c.req.query('live_only') !== 'false'

  let query = supabaseAdmin
    .from('user_reward_log')
    .select('*')
    .eq('user_id', userId)
    .order('settled_for_month', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)

  if (fiscalYear) {
    query = query.eq('fiscal_year', Number(fiscalYear))
  }
  if (liveOnly) {
    query = query.eq('is_test_mode', false)
  }

  const { data, error } = await query
  if (error) {
    return c.json({ error: error.message }, 500)
  }
  return c.json({ data })
})

// ── 본인 잉여 데이터 (다음 v 이월 대기) ────────────────────────────────
// GET /api/user/rewards/kept-data
userRewards.get('/rewards/kept-data', async (c) => {
  const userId = c.get('userId')
  if (!userId) {
    return c.json({ error: 'unauthenticated' }, 401)
  }

  const { data, error } = await supabaseAdmin
    .from('kept_data_pool')
    .select('id, utterance_id, duration_sec, reason, source_version_id, target_version_id, consumed, consumed_at, created_at')
    .eq('user_id', userId)
    .eq('consumed', false)
    .order('created_at', { ascending: false })

  if (error) {
    return c.json({ error: error.message }, 500)
  }
  return c.json({ data })
})

// ── 공개 — 분기 운영비 결산 (사용자 신뢰 의무, 약관 제13조 6항) ────────
// GET /api/user/rewards/quarterly-public?fiscal_year=2026
// (auth는 거치지만 본인 데이터 아님 — 모든 사용자가 동일 결산 조회 가능)
userRewards.get('/rewards/quarterly-public', async (c) => {
  const fiscalYear = c.req.query('fiscal_year')

  let query = supabaseAdmin
    .from('operating_cost_quarterly')
    .select(
      'fiscal_year, quarter, revenue_krw, total_operating_cost, net_profit_krw, ' +
      'company_retention, speaker_pool_krw, published_at, audit_report_url',
    )
    .not('published_at', 'is', null)
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

// ── 공개 — 분배 알고리즘 메타 (제13조 5항 투명성) ──────────────────────
// GET /api/user/rewards/algorithm-meta
userRewards.get('/rewards/algorithm-meta', async (c) => {
  return c.json({
    data: {
      version: 'v0.6',
      bm: 'v10.0',
      formula: '순이익 = 매출 - 운영비. 50% 회사 유보 + 50% 화자 풀.',
      cap_krw_yearly: 3_000_000,
      cap_reset_date: '매년 1월 1일 00:00 UTC',
      withholding_pct: 22,
      distribution_priority: '선가입자 우선 (priority_index = 가입 순서)',
      time_proportional: '본인 기여 시간 / v 총 시간 × 화자 풀',
      cap_overflow: 'Cap 도달 시 잉여 데이터 자동 다음 v 이월 (영구 자산)',
      settlement_cycle: '매월 말일 마감 → 다음달 15일 자동 송금',
      legal_basis: [
        '약관 v1.1 제11조 (보상금 지급)',
        '소득세법 제21조 (기타소득 분리과세)',
        '약관 v1.1 제18조 (운영비 정의)',
      ],
    },
  })
})

export default userRewards
