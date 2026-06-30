// ── Admin Peers 속성 잠금 API ─────────────────────────────────────────────
// peer 속성(관계/성별/연령/카테고리) 사람 확정 + active-learning 큐.
// 철학: 자동=초벌(GPU peer_attribute_scorer), 사람=확정+잠금(override_locked).
//
// 라우트:
//   GET  /api/admin/peers/queue            — 미확정 peer 를 전파가치(call_count) 내림차순
//   POST /api/admin/peers/:peerId/confirm  — 사람 확정 → override_locked=true·HUMAN_LOCKED
//
// 안전: display_name=비식별 토큰(상대#hash8)만 노출, raw 이름/번호 미반환.
// 설계: plans/snazzy-munching-planet.md

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import { buildPeerConfirmUpdate, mapQueueRow, type PeerConfirmInput } from '../lib/peers/peerConfirm.js'

const adminPeers = new Hono()

adminPeers.use('/peers/*', authMiddleware)
adminPeers.use('/peers/*', adminMiddleware)

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

// GET /api/admin/peers/queue — active-learning(미확정, 전파가치 내림차순).
adminPeers.get('/peers/queue', async (c) => {
  const rawLimit = Number(c.req.query('limit'))
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT, MAX_LIMIT)
  const rawOffset = Number(c.req.query('offset'))
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0

  const { data, error } = await supabaseAdmin
    .from('peers')
    .select(
      'id, display_name, relationship, rel_source, rel_confidence, attr_category, attr_state, gender, gender_source, call_count',
    )
    .eq('override_locked', false)
    .order('call_count', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({
    success: true,
    data: (data ?? []).map(mapQueueRow),
    meta: { limit, offset, count: data?.length ?? 0 },
  })
})

// POST /api/admin/peers/:peerId/confirm — 사람 확정(잠금). admin 재확정 허용(409 아님).
adminPeers.post('/peers/:peerId/confirm', async (c) => {
  const peerId = c.req.param('peerId')
  const body = getBody<PeerConfirmInput>(c) ?? {}

  const { data: peer, error: pErr } = await supabaseAdmin
    .from('peers')
    .select('id')
    .eq('id', peerId)
    .single()
  if (pErr || !peer) return c.json({ error: 'peer 를 찾을 수 없습니다.' }, 404)

  const lockedBy = c.get('userId') as string
  const built = buildPeerConfirmUpdate(body, lockedBy, new Date().toISOString())
  if ('error' in built) return c.json({ error: built.error }, 400)

  const { data, error } = await supabaseAdmin
    .from('peers')
    .update(built.update)
    .eq('id', peerId)
    .select(
      'id, relationship, rel_source, rel_confidence, attr_category, attr_state, gender, gender_source, age_band, override_locked, locked_by, locked_at',
    )
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true, data })
})

export default adminPeers
