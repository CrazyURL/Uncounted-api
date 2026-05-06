// ── Admin Utterances v2 API (BM v10 발화 단위 정산) ───────────────────
// 마이그레이션 055 — utterances 에 duration_seconds / unit_price_krw / settled_at 추가
//
// BU 폐기 — billable_units 테이블 대신 utterances 가 정산 단위.
// 본 라우트는 utterance 단위 조회 + 정산 상태 표시 전용.
//
// 라우트:
//   GET /api/admin/utterances-v2 — 발화 목록 (필터 + 페이지네이션)
//   GET /api/admin/utterances-v2/stats — 정산 합계 / 미정산 카운트
//
// 기존 admin-utterances.ts 와 충돌 방지를 위해 -v2 suffix.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware } from '../lib/middleware.js'

const adminUtterancesV2 = new Hono()

adminUtterancesV2.use('/*', authMiddleware)
adminUtterancesV2.use('/*', adminMiddleware)

const HOURLY_RATE_KRW = 30_000

adminUtterancesV2.get('/utterances-v2', async (c) => {
  const url = new URL(c.req.url)
  const settled = url.searchParams.get('settled')  // 'yes' | 'no' | null
  const sessionId = url.searchParams.get('session_id') ?? undefined
  const search = url.searchParams.get('q') ?? undefined
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50))
  const offset = (page - 1) * limit

  let query = supabaseAdmin
    .from('utterances')
    .select(
      'id, session_id, speaker_id, start_ms, end_ms, text, duration_seconds, unit_price_krw, settled_at',
      { count: 'exact' },
    )
    .order('start_ms', { ascending: true })
    .range(offset, offset + limit - 1)

  if (settled === 'yes') query = query.not('settled_at', 'is', null)
  else if (settled === 'no') query = query.is('settled_at', null)
  if (sessionId) query = query.eq('session_id', sessionId)
  if (search) query = query.ilike('text', `%${search}%`)

  const { data, error, count } = await query
  if (error) return c.json({ error: error.message }, 500)

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  const utterances = rows.map((row) => {
    const startMs = (row.start_ms as number) ?? 0
    const endMs = (row.end_ms as number) ?? 0
    const storedDur = row.duration_seconds as number | null
    const durSec = storedDur ?? Math.max(0, (endMs - startMs) / 1000)
    const storedPrice = row.unit_price_krw as number | null
    const computedPrice = Math.round((durSec * HOURLY_RATE_KRW) / 3600)
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      speaker_id: (row.speaker_id as string) ?? null,
      start_ms: startMs,
      end_ms: endMs,
      duration_seconds: durSec,
      text: ((row.text as string) ?? '').slice(0, 200),
      unit_price_krw: storedPrice ?? computedPrice,
      settled_at: (row.settled_at as string) ?? null,
    }
  })

  return c.json({
    utterances,
    total: count ?? 0,
    page,
    limit,
    constants: { hourlyRateKrw: HOURLY_RATE_KRW },
  })
})

adminUtterancesV2.get('/utterances-v2/stats', async (c) => {
  const [totalRes, settledRes, unsettledRes] = await Promise.all([
    supabaseAdmin.from('utterances').select('id', { count: 'exact', head: true }),
    supabaseAdmin
      .from('utterances')
      .select('id', { count: 'exact', head: true })
      .not('settled_at', 'is', null),
    supabaseAdmin
      .from('utterances')
      .select('id', { count: 'exact', head: true })
      .is('settled_at', null),
  ])

  // 시간 합산 — duration_seconds 우선, 없으면 (end_ms-start_ms)/1000
  const { data: durRows } = await supabaseAdmin
    .from('utterances')
    .select('duration_seconds, start_ms, end_ms')

  let totalDurationSec = 0
  for (const row of (durRows ?? []) as Array<Record<string, unknown>>) {
    const stored = row.duration_seconds as number | null
    if (stored != null) {
      totalDurationSec += stored
    } else {
      const startMs = (row.start_ms as number) ?? 0
      const endMs = (row.end_ms as number) ?? 0
      totalDurationSec += Math.max(0, (endMs - startMs) / 1000)
    }
  }

  return c.json({
    total: totalRes.count ?? 0,
    settledCount: settledRes.count ?? 0,
    unsettledCount: unsettledRes.count ?? 0,
    totalDurationSec,
    estimatedRevenueKrw: Math.round((totalDurationSec * HOURLY_RATE_KRW) / 3600),
  })
})

export default adminUtterancesV2
