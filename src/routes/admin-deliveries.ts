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
import { splitRevenue } from '../lib/pricing.js'

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

// ── GET /api/admin/deliveries/check-utterances ───────────────────────
// 발화 단위 중복판매 사전 검증 (마이그레이션 060):
//   utterance_ids 중 이미 (utterance_id, client_id) 로 납품된 항목 반환 → 409 차단 대상
adminDeliveries.get('/deliveries/check-utterances', async (c) => {
  const url = new URL(c.req.url)
  const clientId = url.searchParams.get('client_id')
  const utteranceIdsRaw = url.searchParams.get('utterance_ids')
  if (!clientId || !utteranceIdsRaw) {
    return c.json({ error: 'client_id and utterance_ids required' }, 400)
  }
  const utteranceIds = utteranceIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  if (utteranceIds.length === 0) {
    return c.json({ data: { duplicates: [] } })
  }

  const { data, error } = await supabaseAdmin
    .from('utterance_deliveries')
    .select('utterance_id, delivery_id, sold_at')
    .eq('client_id', clientId)
    .in('utterance_id', utteranceIds)
  if (error) return c.json({ error: error.message }, 500)

  return c.json({ data: { duplicates: data ?? [] } })
})

// ── POST /api/admin/deliveries ───────────────────────────────────────
adminDeliveries.post('/deliveries', async (c) => {
  const body = getBody<{
    session_id?: string
    client_id?: string
    price_krw?: number
    notes?: string
    utterance_ids?: string[]
  }>(c)

  const sessionId = body?.session_id
  const clientId = body?.client_id
  const priceKrw = body?.price_krw
  const notes = body?.notes ?? null
  const utteranceIds = Array.isArray(body?.utterance_ids)
    ? body!.utterance_ids!.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : []

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

  // 발화 단위 중복판매 사전 검증 (utterance_ids 제공 시)
  if (utteranceIds.length > 0) {
    const { data: dupRows, error: dupErr } = await supabaseAdmin
      .from('utterance_deliveries')
      .select('utterance_id')
      .eq('client_id', clientId)
      .in('utterance_id', utteranceIds)
    if (dupErr) {
      return c.json({ error: dupErr.message, code: dupErr.code }, 500)
    }
    if (dupRows && dupRows.length > 0) {
      return c.json(
        {
          error: 'some utterances already delivered to this client',
          duplicates: dupRows.map((r) => r.utterance_id),
        },
        409,
      )
    }
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

  // 발화 단위 납품 매핑 INSERT (배치)
  if (utteranceIds.length > 0 && inserted) {
    const sharePerUtt =
      utteranceIds.length > 0 ? Math.floor(Math.floor(priceKrw) / utteranceIds.length) : 0
    const rows = utteranceIds.map((uttId) => ({
      utterance_id: uttId,
      delivery_id: inserted.id,
      client_id: clientId,
      price_share_krw: sharePerUtt,
    }))
    const { error: uddErr } = await supabaseAdmin.from('utterance_deliveries').insert(rows)
    if (uddErr) {
      // 매핑 실패 시 deliveries 롤백 (발화-납품 일관성)
      await supabaseAdmin.from('deliveries').delete().eq('id', inserted.id)
      if (uddErr.code === '23505') {
        return c.json(
          { error: 'utterance already delivered to this client (race)', code: uddErr.code },
          409,
        )
      }
      return c.json({ error: uddErr.message, code: uddErr.code }, 500)
    }
  }

  // 50:50 분배 — 응답에 사용자/플랫폼 수익 포함 (STAGE 13)
  const share = splitRevenue(Math.floor(priceKrw))
  return c.json({
    data: {
      ...inserted,
      user_share_krw: share.userShareKrw,
      platform_share_krw: share.platformShareKrw,
    },
  })
})

export default adminDeliveries
