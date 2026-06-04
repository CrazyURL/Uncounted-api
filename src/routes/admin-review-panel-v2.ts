// ── Admin Review Panel v2 API (검수 패널 재설계 P1) ─────────────────────
// 마이그레이션 075 — utterance_gt / reprocess_signal / utterance_revisions /
// session_reprocess_runs / holdout_sets / holdout_set_sessions
//
// Spec: docs/design_review_panel_redesign_20260603.md §3·§4
//
// 라우트:
//   POST   /api/admin/utterance-gt              — 검수 GT 저장 (신규)
//   PATCH  /api/admin/utterance-gt/:id          — GT 수정
//   POST   /api/admin/utterance-revisions       — 정정 audit 기록
//   GET    /api/admin/review-queue/utterances   — 발화 검수 큐 (tier 필터)
//   GET    /api/admin/review-queue/sessions     — 통화 검수 큐 (tier 필터)
//
// ⚠ /sessions/queue, /utterances/queue 패턴은 기존 /sessions/:id, /utterances/:id
//   라우트와 충돌 (queue 를 :id 로 매칭). /review-queue/* 접두로 분리.
//
// 정본 §2.4 자동승인 Tier 정책은 CBO 합의 후 별도 라우트.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'

const adminReviewPanelV2 = new Hono()

adminReviewPanelV2.use('/*', authMiddleware)
adminReviewPanelV2.use('/*', adminMiddleware)

// ─────────────────────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────────────────────

type PriorityTier = 'red' | 'yellow' | 'green'

interface PiiInterval {
  start_char: number
  end_char: number
  pii_type: string
  source: 'human' | 'auto'
  confidence?: number
}

interface UtteranceGtPayload {
  utterance_id: string
  session_id: string
  gt_transcript: string
  gt_speaker?: '본인' | '상대' | 'unknown' | null
  gt_pii_intervals?: PiiInterval[]
  review_method?: 'human' | 'auto_approve' | 'spot_check_passed'
  reviewer_comment?: string | null
  status?: 'draft' | 'approved' | 'rejected' | 'deferred_split'
  exclude_reason?: '잡음' | '화자혼재' | '동의불완전' | 'PII우려' | '기타' | null
  exclude_reason_note?: string | null
}

interface UtteranceRevisionPayload {
  utterance_id?: string | null
  session_id: string
  revision_type: 'text_correction' | 'speaker_relabel' | 'pii_addition' | 'pii_removal' | 'exclude'
  payload: Record<string, unknown>
  reason?: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. POST /utterance-gt — 검수 GT 저장
// ─────────────────────────────────────────────────────────────────────────────

adminReviewPanelV2.post('/utterance-gt', async (c) => {
  const userId = c.get('userId') as string
  const body = getBody<UtteranceGtPayload>(c)

  if (!body.utterance_id || !body.session_id || !body.gt_transcript) {
    return c.json({ error: 'utterance_id, session_id, gt_transcript 필수' }, 400)
  }

  const status = body.status ?? 'draft'
  const approvedAt = status === 'approved' ? new Date().toISOString() : null

  const { data, error } = await supabaseAdmin
    .from('utterance_gt')
    .insert({
      utterance_id: body.utterance_id,
      session_id: body.session_id,
      gt_transcript: body.gt_transcript,
      gt_speaker: body.gt_speaker ?? null,
      gt_pii_intervals: body.gt_pii_intervals ?? [],
      reviewer_user_id: userId,
      review_method: body.review_method ?? 'human',
      reviewer_comment: body.reviewer_comment ?? null,
      status,
      exclude_reason: body.exclude_reason ?? null,
      exclude_reason_note: body.exclude_reason_note ?? null,
      approved_at: approvedAt,
    })
    .select()
    .single()

  if (error) {
    return c.json({ error: error.message }, 500)
  }
  return c.json({ data })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. PATCH /utterance-gt/:id — GT 수정
// ─────────────────────────────────────────────────────────────────────────────

adminReviewPanelV2.patch('/utterance-gt/:id', async (c) => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'id required' }, 400)

  const body = getBody<Partial<UtteranceGtPayload>>(c)

  const updates: Record<string, unknown> = {}
  if (body.gt_transcript !== undefined) updates.gt_transcript = body.gt_transcript
  if (body.gt_speaker !== undefined) updates.gt_speaker = body.gt_speaker
  if (body.gt_pii_intervals !== undefined) updates.gt_pii_intervals = body.gt_pii_intervals
  if (body.reviewer_comment !== undefined) updates.reviewer_comment = body.reviewer_comment
  if (body.status !== undefined) {
    updates.status = body.status
    if (body.status === 'approved') {
      updates.approved_at = new Date().toISOString()
    }
  }
  if (body.exclude_reason !== undefined) updates.exclude_reason = body.exclude_reason
  if (body.exclude_reason_note !== undefined) updates.exclude_reason_note = body.exclude_reason_note

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'no fields to update' }, 400)
  }

  const { data, error } = await supabaseAdmin
    .from('utterance_gt')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return c.json({ error: error.message }, 500)
  }
  return c.json({ data })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /utterance-revisions — 정정 audit 기록
// ─────────────────────────────────────────────────────────────────────────────

adminReviewPanelV2.post('/utterance-revisions', async (c) => {
  const userId = c.get('userId') as string
  const body = getBody<UtteranceRevisionPayload | UtteranceRevisionPayload[]>(c)

  // 단건 또는 배열 모두 지원 (정정 4종을 한 번에 보낼 때)
  const items: UtteranceRevisionPayload[] = Array.isArray(body) ? body : [body]

  for (const item of items) {
    if (!item.session_id || !item.revision_type || !item.payload) {
      return c.json({ error: 'session_id, revision_type, payload 필수' }, 400)
    }
  }

  const rows = items.map((item) => ({
    utterance_id: item.utterance_id ?? null,
    session_id: item.session_id,
    reviewer_user_id: userId,
    revision_type: item.revision_type,
    payload: item.payload,
    reason: item.reason ?? null,
  }))

  const { data, error } = await supabaseAdmin
    .from('utterance_revisions')
    .insert(rows)
    .select()

  if (error) {
    return c.json({ error: error.message }, 500)
  }
  return c.json({ data, count: data?.length ?? 0 })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /review-queue/utterances — 발화 검수 큐
// ─────────────────────────────────────────────────────────────────────────────
// 쿼리:
//   tier      = red | yellow | green | all  (기본 red)
//   session_id= optional
//   limit     = 1~500 (기본 50)
//   offset    = 0~ (페이지네이션)
//   exclude_reviewed = 'true' → 이미 GT 가 있는 발화 제외
// ─────────────────────────────────────────────────────────────────────────────

adminReviewPanelV2.get('/review-queue/utterances', async (c) => {
  const url = new URL(c.req.url)
  const tier = (url.searchParams.get('tier') ?? 'red') as PriorityTier | 'all'
  const sessionId = url.searchParams.get('session_id')
  const excludeReviewed = url.searchParams.get('exclude_reviewed') === 'true'
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50))
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)

  let query = supabaseAdmin
    .from('utterances')
    .select(
      'id, session_id, sequence_order, start_sec, end_sec, duration_sec, speaker_id, is_user, transcript_text, quality_grade, quality_score, emotion, emotion_confidence, dialog_act, pii_intervals, review_priority_score, review_priority_tier, dataset_tier',
      { count: 'exact' },
    )
    .order('review_priority_score', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1)

  if (tier !== 'all') {
    query = query.eq('review_priority_tier', tier)
  }
  if (sessionId) {
    query = query.eq('session_id', sessionId)
  }

  const { data: rows, error, count } = await query
  if (error) {
    return c.json({ error: error.message }, 500)
  }

  let items = rows ?? []

  // exclude_reviewed 옵션: utterance_gt 에 이미 row 있는 발화 제외
  if (excludeReviewed && items.length > 0) {
    const utteranceIds = items.map((r) => r.id)
    const { data: gtRows } = await supabaseAdmin
      .from('utterance_gt')
      .select('utterance_id')
      .in('utterance_id', utteranceIds)
    const reviewedIds = new Set((gtRows ?? []).map((g) => g.utterance_id))
    items = items.filter((r) => !reviewedIds.has(r.id))
  }

  return c.json({
    data: items,
    meta: { total: count ?? items.length, limit, offset, tier },
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. GET /review-queue/sessions — 통화 검수 큐
// ─────────────────────────────────────────────────────────────────────────────
// 쿼리:
//   tier      = red | yellow | green | all  (기본 red)
//   limit     = 1~100 (기본 20)
//   offset    = 0~
// ─────────────────────────────────────────────────────────────────────────────

adminReviewPanelV2.get('/review-queue/sessions', async (c) => {
  const url = new URL(c.req.url)
  const tier = (url.searchParams.get('tier') ?? 'red') as PriorityTier | 'all'
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '20', 10) || 20))
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)

  let query = supabaseAdmin
    .from('sessions')
    .select(
      'id, user_id, peer_id, duration, utterance_count, title, review_status, call_review_score, call_review_tier, billing_utterance_count, billing_frozen_at, stt_at',
      { count: 'exact' },
    )
    .order('call_review_score', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1)

  if (tier !== 'all') {
    query = query.eq('call_review_tier', tier)
  }

  const { data: rows, error, count } = await query
  if (error) {
    return c.json({ error: error.message }, 500)
  }

  // utterances 분포 (red/yellow/green) 집계 — 큐에서 reason 표시용
  // N+1 회피 위해 RPC 또는 직접 join 권장. 본 prototype 은 N 회 query 로 단순.
  const items = rows ?? []
  if (items.length === 0) {
    return c.json({ data: [], meta: { total: 0, limit, offset, tier } })
  }

  const sessionIds = items.map((s) => s.id)
  const { data: tierStats } = await supabaseAdmin
    .from('utterances')
    .select('session_id, review_priority_tier')
    .in('session_id', sessionIds)

  const statsMap = new Map<string, { red: number; yellow: number; green: number }>()
  for (const row of tierStats ?? []) {
    const sid = (row as { session_id: string }).session_id
    const t = (row as { review_priority_tier: PriorityTier | null }).review_priority_tier
    if (!statsMap.has(sid)) statsMap.set(sid, { red: 0, yellow: 0, green: 0 })
    if (t === 'red' || t === 'yellow' || t === 'green') statsMap.get(sid)![t]++
  }

  const enriched = items.map((s) => {
    const stats = statsMap.get(s.id) ?? { red: 0, yellow: 0, green: 0 }
    return {
      ...s,
      red_utterance_count: stats.red,
      yellow_utterance_count: stats.yellow,
      green_utterance_count: stats.green,
    }
  })

  return c.json({
    data: enriched,
    meta: { total: count ?? enriched.length, limit, offset, tier },
  })
})

export default adminReviewPanelV2
