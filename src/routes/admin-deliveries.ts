// ── Admin Deliveries API ──────────────────────────────────────────────
// BM v10 비배타적 라이선스 — deliveries 테이블 (마이그레이션 054)
//
// 라우트:
//   GET  /api/admin/deliveries              — 납품 이력
//   GET  /api/admin/deliveries/check        — (session_id, client_id) 중복 + 다른 매수자 납품 이력 조회
//   POST /api/admin/deliveries              — 신규 납품 등록 (UNIQUE 제약 위반 시 409)

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'

const adminDeliveries = new Hono()

adminDeliveries.use('/*', authMiddleware)
adminDeliveries.use('/*', adminMiddleware)

// ── GET /api/admin/deliveries ────────────────────────────────────────
adminDeliveries.get('/deliveries', async (c) => {
  const url = new URL(c.req.url)
  const clientId = url.searchParams.get('client_id') ?? undefined
  const sessionId = url.searchParams.get('session_id') ?? undefined
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50))
  const offset = (page - 1) * limit

  let query = supabaseAdmin
    .from('deliveries')
    .select(
      'id, session_id, client_id, delivered_at, price_krw, delivered_by, notes, created_at',
      { count: 'exact' },
    )
    .order('delivered_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (clientId) query = query.eq('client_id', clientId)
  if (sessionId) query = query.eq('session_id', sessionId)

  const { data, error, count } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data: { deliveries: data ?? [], total: count ?? 0 } })
})

// ── GET /api/admin/deliveries/check ──────────────────────────────────
// 비배타적 라이선스 핵심 검증:
//   - duplicate=true  → 동일 매수자에 이미 납품됨 (UNIQUE 제약 위반 예정 → 차단)
//   - alreadyDeliveredToOthers=true → 다른 매수자에 납품된 적 있음 (진행 가능, 안내)
adminDeliveries.get('/deliveries/check', async (c) => {
  const url = new URL(c.req.url)
  const sessionId = url.searchParams.get('session_id')
  const clientId = url.searchParams.get('client_id')
  if (!sessionId || !clientId) {
    return c.json({ error: 'session_id and client_id required' }, 400)
  }

  // session_id 의 모든 납품 이력 조회 (client 정보 join)
  const { data: existingRows, error } = await supabaseAdmin
    .from('deliveries')
    .select('client_id, delivered_at, clients(name)')
    .eq('session_id', sessionId)
  if (error) return c.json({ error: error.message }, 500)

  const rows = existingRows ?? []
  const duplicate = rows.some((r) => r.client_id === clientId)
  const alreadyDeliveredToOthers = rows.some((r) => r.client_id !== clientId)

  const existingDeliveries = rows.map((r) => ({
    client_id: r.client_id as string,
    client_name: (r.clients as unknown as { name?: string } | null)?.name ?? '',
    delivered_at: r.delivered_at as string,
  }))

  return c.json({ data: { duplicate, alreadyDeliveredToOthers, existingDeliveries } })
})

// ── POST /api/admin/deliveries ───────────────────────────────────────
adminDeliveries.post('/deliveries', async (c) => {
  const body = getBody<{
    session_id?: string
    client_id?: string
    price_krw?: number
    notes?: string
  }>(c)

  const sessionId = body?.session_id
  const clientId = body?.client_id
  const priceKrw = body?.price_krw
  const notes = body?.notes ?? null

  if (!sessionId || !clientId) {
    return c.json({ error: 'session_id and client_id required' }, 400)
  }
  if (typeof priceKrw !== 'number' || !Number.isFinite(priceKrw) || priceKrw < 0) {
    return c.json({ error: 'price_krw must be a non-negative integer' }, 400)
  }

  // 검수 승인 여부 사전 검증
  const { data: session, error: sErr } = await supabaseAdmin
    .from('sessions')
    .select('id, review_status')
    .eq('id', sessionId)
    .single()
  if (sErr || !session) {
    return c.json({ error: 'session not found' }, 404)
  }
  if (session.review_status !== 'approved') {
    return c.json(
      { error: `session review_status must be approved (current: ${session.review_status})` },
      409,
    )
  }

  // 매수자 존재 검증
  const { data: client, error: cErr } = await supabaseAdmin
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .single()
  if (cErr || !client) {
    return c.json({ error: 'client not found' }, 404)
  }

  // INSERT — UNIQUE(session_id, client_id) 위반 시 PostgreSQL 23505 → 409 변환
  const deliveredBy = c.get('userId') ?? null

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('deliveries')
    .insert({
      session_id: sessionId,
      client_id: clientId,
      price_krw: Math.floor(priceKrw),
      notes,
      delivered_by: deliveredBy,
    })
    .select()
    .single()

  if (insErr) {
    if (insErr.code === '23505') {
      return c.json({ error: 'already delivered to this client (duplicate)' }, 409)
    }
    return c.json({ error: insErr.message, code: insErr.code }, 500)
  }

  return c.json({ data: inserted })
})

export default adminDeliveries
