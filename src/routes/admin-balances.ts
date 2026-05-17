// ── Admin Balances API ────────────────────────────────────────────────
// BM v10 사용자별 잔액 + 연간 한도 도달률
//
// 라우트:
//   GET /api/admin/balances — 사용자별 발화 시간 합산 + 연간 한도 도달률
//
// 정산 단위: 발화(utterance) — duration_seconds × hourly_rate / 3600
// 시드 단가: 30,000원/시간 (BASE_RATE 평균) × USER_SHARE 0.5 = 15,000원/시간
// 연간 한도: ₩3,000,000 (소득세법 분리과세 한도)

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware } from '../lib/middleware.js'
import { HOURLY_RATE_KRW, USER_SHARE_RATIO } from '../lib/pricing.js'

const adminBalances = new Hono()

adminBalances.use('/*', authMiddleware)
adminBalances.use('/*', adminMiddleware)

const YEARLY_CAP_KRW = 3_000_000

adminBalances.get('/balances', async (c) => {
  const url = new URL(c.req.url)
  const search = url.searchParams.get('q') ?? undefined
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '100', 10) || 100))

  // 사용자별 발화 시간 합산 — Phase 0.6 정합:
  //   1. 양측 동의 + 검수 승인된 sessions 의 utterances duration_seconds 합산 (정확 단위)
  //   2. utterances 가 없는 sessions 는 sessions.duration 으로 fallback (시드 데이터)
  const { data: approvedSessions, error: sErr } = await supabaseAdmin
    .from('sessions')
    .select('id, user_id, duration')
    .eq('consent_status', 'both_agreed')
  if (sErr) return c.json({ error: sErr.message }, 500)

  const sessionsArr = (approvedSessions ?? []) as Array<{
    id: string
    user_id: string | null
    duration: number | null
  }>

  // session → user_id 매핑 + duration fallback
  const sessionToUser = new Map<string, string>()
  const sessionFallbackDur = new Map<string, number>()
  for (const s of sessionsArr) {
    if (!s.user_id) continue
    sessionToUser.set(s.id, s.user_id)
    sessionFallbackDur.set(s.id, s.duration ?? 0)
  }

  // utterances 합산 — duration_seconds 가 없으면 (end_ms-start_ms)/1000
  const sessionIds = Array.from(sessionToUser.keys())
  const sessionUtteranceDur = new Map<string, number>()  // session_id → utterance 합산 초
  if (sessionIds.length > 0) {
    // chunked IN — URL too long 방지
    const chunkSize = 100
    for (let i = 0; i < sessionIds.length; i += chunkSize) {
      const chunk = sessionIds.slice(i, i + chunkSize)
      const { data: uttRows } = await supabaseAdmin
        .from('utterances')
        .select('session_id, duration_seconds, start_ms, end_ms')
        .in('session_id', chunk)
      for (const row of (uttRows ?? []) as Array<Record<string, unknown>>) {
        const sid = row.session_id as string
        const stored = row.duration_seconds as number | null
        const startMs = (row.start_ms as number) ?? 0
        const endMs = (row.end_ms as number) ?? 0
        const dur = stored ?? Math.max(0, (endMs - startMs) / 1000)
        sessionUtteranceDur.set(sid, (sessionUtteranceDur.get(sid) ?? 0) + dur)
      }
    }
  }

  // user 단위 합산 — utterances 우선, fallback to sessions.duration
  const byUser = new Map<string, { duration: number; source: 'utterance' | 'session' | 'mixed' }>()
  for (const sid of sessionIds) {
    const userId = sessionToUser.get(sid)!
    const utteranceDur = sessionUtteranceDur.get(sid)
    const fallbackDur = sessionFallbackDur.get(sid) ?? 0

    const dur = utteranceDur != null && utteranceDur > 0 ? utteranceDur : fallbackDur
    const source: 'utterance' | 'session' = utteranceDur != null && utteranceDur > 0 ? 'utterance' : 'session'

    const cur = byUser.get(userId) ?? { duration: 0, source: source }
    cur.duration += dur
    if (cur.source !== source) cur.source = 'mixed'
    byUser.set(userId, cur)
  }

  // 납품/정산 집계
  const { data: deliveryRows } = await supabaseAdmin.from('deliveries').select('session_id')
  const deliveredSessionSet = new Set(
    (deliveryRows ?? []).map((r: { session_id: string }) => r.session_id),
  )

  const deliveredSessionCount = deliveredSessionSet.size
  const undeliveredSessionCount = sessionIds.length - deliveredSessionSet.size

  const deliveredUserSet = new Set<string>()
  for (const sid of sessionIds) {
    const userId = sessionToUser.get(sid)
    if (!userId) continue
    if (deliveredSessionSet.has(sid)) deliveredUserSet.add(userId)
  }
  // 납품 완료 세션이 하나도 없는 사용자만 미납품 사용자로 산정
  const undeliveredUserCount = byUser.size - deliveredUserSet.size

  const [settledUttRes, unsettledUttRes] = await Promise.all([
    supabaseAdmin
      .from('utterances')
      .select('id', { count: 'exact', head: true })
      .not('settled_at', 'is', null),
    supabaseAdmin.from('utterances').select('id', { count: 'exact', head: true }).is('settled_at', null),
  ])

  // 사용자 정보 조회 (auth.users)
  const userIds = Array.from(byUser.keys())
  if (userIds.length === 0) return c.json({ data: { users: [], totalUsers: 0 } })

  const userInfoMap = new Map<string, { email?: string }>()
  // batch — auth.admin.listUsers 는 페이지네이션 필요. 시드 단계 N=10~30이므로 단건 조회 허용
  for (const uid of userIds.slice(0, limit)) {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(uid)
      if (!error && data?.user) {
        userInfoMap.set(uid, { email: data.user.email ?? undefined })
      }
    } catch {
      // skip
    }
  }

  // 정산 계산
  const users = Array.from(byUser.entries())
    .map(([userId, value]) => {
      const durationSec = value.duration
      const hours = durationSec / 3600
      const grossKrw = Math.round(hours * HOURLY_RATE_KRW)
      const userPayoutKrw = Math.min(Math.round(grossKrw * USER_SHARE_RATIO), YEARLY_CAP_KRW)
      const capRatio = userPayoutKrw / YEARLY_CAP_KRW
      const info = userInfoMap.get(userId)
      return {
        userId,
        email: info?.email ?? null,
        durationSec,
        hours,
        grossKrw,
        userPayoutKrw,
        capRatio,
        capReached: capRatio >= 1.0,
        capApproaching: capRatio >= 0.8 && capRatio < 1.0,
        durationSource: value.source,  // 'utterance' / 'session' / 'mixed'
      }
    })
    .sort((a, b) => b.userPayoutKrw - a.userPayoutKrw)

  const filtered = search
    ? users.filter((u) => u.email?.toLowerCase().includes(search.toLowerCase()) || u.userId.includes(search))
    : users

  return c.json({
    data: {
      users: filtered.slice(0, limit),
      totalUsers: filtered.length,
      constants: {
        hourlyRateKrw: HOURLY_RATE_KRW,
        userShareRatio: USER_SHARE_RATIO,
        yearlyCapKrw: YEARLY_CAP_KRW,
      },
      settlementStats: {
        settledUtteranceCount: settledUttRes.count ?? 0,
        unsettledUtteranceCount: unsettledUttRes.count ?? 0,
        deliveredSessionCount,
        undeliveredSessionCount,
        deliveredUserCount: deliveredUserSet.size,
        undeliveredUserCount,
      },
    },
  })
})

export default adminBalances
