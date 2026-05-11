// ── Admin Dashboard Stats API ─────────────────────────────────────────
// BM v10 종합 현황 대시보드 5탭용 카운트 집계
//
// 라우트:
//   GET /api/admin/dashboard-stats — 5탭 카운트 한 번에 반환

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware } from '../lib/middleware.js'

const adminDashboard = new Hono()

adminDashboard.use('/*', authMiddleware)
adminDashboard.use('/*', adminMiddleware)

interface PipelineCount {
  pending: number
  running: number
  done: number
  failed: number
}

async function pipelineDistribution(column: string): Promise<PipelineCount> {
  const out: PipelineCount = { pending: 0, running: 0, done: 0, failed: 0 }
  const states: (keyof PipelineCount)[] = ['pending', 'running', 'done', 'failed']
  for (const s of states) {
    const { count } = await supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('consent_status', 'both_agreed')
      .eq(column, s)
    out[s] = count ?? 0
  }
  return out
}

adminDashboard.get('/dashboard-stats', async (c) => {
  // 1. 양측 동의 카운트 + 24h 추이
  const [{ count: bothAgreedCount }, { count: bothAgreed24h }] = await Promise.all([
    supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('consent_status', 'both_agreed'),
    supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('consent_status', 'both_agreed')
      .gte('consented_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
  ])

  // 양측 동의 통화 시간 합산
  const { data: durRows } = await supabaseAdmin
    .from('sessions')
    .select('duration')
    .eq('consent_status', 'both_agreed')
  const totalDurationSec = (durRows ?? []).reduce(
    (sum, row) => sum + ((row as { duration?: number }).duration ?? 0),
    0,
  )

  // 2. 처리 흐름 단계별 분포 (sessions 의 5개 GPU 상태 컬럼)
  // DB 컬럼: gpu_upload_status / stt_status / diarize_status / gpu_pii_status / quality_status
  const [upload, stt, diarize, pii, quality] = await Promise.all([
    pipelineDistribution('gpu_upload_status'),
    pipelineDistribution('stt_status'),
    pipelineDistribution('diarize_status'),
    pipelineDistribution('gpu_pii_status'),
    pipelineDistribution('quality_status'),
  ])

  // 3. 검수 상태별 분포
  const reviewStates = ['pending', 'in_review', 'approved', 'rejected', 'needs_revision'] as const
  const reviewCountsArr = await Promise.all(
    reviewStates.map((s) =>
      supabaseAdmin
        .from('sessions')
        .select('id', { count: 'exact', head: true })
        .eq('consent_status', 'both_agreed')
        .eq('review_status', s),
    ),
  )
  const review = Object.fromEntries(
    reviewStates.map((s, i) => [s, reviewCountsArr[i].count ?? 0]),
  ) as Record<(typeof reviewStates)[number], number>

  // 4. 납품 — 최근 deliveries
  let deliveryTotal = 0
  let recentRevenue = 0
  let recentDeliveries: Array<{
    id: string
    session_id: string
    client_id: string
    delivered_at: string
    price_krw: number
  }> = []
  try {
    const { data: dRows, count } = await supabaseAdmin
      .from('deliveries')
      .select('id, session_id, client_id, delivered_at, price_krw', {
        count: 'exact',
      })
      .order('delivered_at', { ascending: false })
      .limit(10)
    deliveryTotal = count ?? 0
    recentDeliveries = (dRows ?? []) as typeof recentDeliveries

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: rRows } = await supabaseAdmin
      .from('deliveries')
      .select('price_krw')
      .gte('delivered_at', since)
    recentRevenue = (rRows ?? []).reduce(
      (sum, r) => sum + ((r as { price_krw?: number }).price_krw ?? 0),
      0,
    )
  } catch {
    // deliveries 테이블이 아직 없을 수 있음 (마이그레이션 054 미적용) — 0 으로 안전 처리
  }

  // 5. 이상 신호 — GPU 단계 실패 + 운영자 거절
  const [{ count: pipelineFailedCount }, { count: rejectedCount }] = await Promise.all([
    supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('consent_status', 'both_agreed')
      .or('gpu_upload_status.eq.failed,stt_status.eq.failed,diarize_status.eq.failed,gpu_pii_status.eq.failed,quality_status.eq.failed'),
    supabaseAdmin
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('consent_status', 'both_agreed')
      .eq('review_status', 'rejected'),
  ])

  return c.json({
    data: {
      consent: {
        bothAgreedCount: bothAgreedCount ?? 0,
        bothAgreed24h: bothAgreed24h ?? 0,
        totalDurationSec,
      },
      pipeline: {
        upload,
        stt,
        diarize,
        pii,
        quality,
      },
      review,
      delivery: {
        total: deliveryTotal,
        recentRevenue,
        recent: recentDeliveries,
      },
      alerts: {
        pipelineFailedCount: pipelineFailedCount ?? 0,
        rejectedCount: rejectedCount ?? 0,
      },
    },
  })
})

export default adminDashboard
