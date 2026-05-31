// ── Admin Analytics API (PR-E1) ────────────────────────────────────────
// PR-A safety preflight + PR-D label_confidence_tier 결과 코퍼스 sweep.
//
// 라우트:
//   GET /api/admin/analytics/preflight   — PR-A 5 카테고리 sweep + tier 분포
//   GET /api/admin/analytics/confidence  — PR-D tier 분포 + 통계
//
// 원칙:
//   - 원문/snippet/PII 0 — helper 가 카운트만 emit, route 는 통과.
//   - DB write 0 — pure read.
//   - admin 인증 강제 (authMiddleware + adminMiddleware).

import { Hono } from 'hono'

import { authMiddleware, adminMiddleware } from '../lib/middleware.js'
import { supabaseAdmin } from '../lib/supabase.js'
import { buildPreflightSnapshot } from '../lib/analytics/preflightSnapshot.js'
import { buildConfidenceSnapshot } from '../lib/analytics/confidenceSnapshot.js'

const adminAnalytics = new Hono()

adminAnalytics.use('/*', authMiddleware)
adminAnalytics.use('/*', adminMiddleware)

const DEFAULT_UTT_LIMIT = 5000
const MAX_UTT_LIMIT = 20000

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

function parseTopLimit(raw: string | undefined): number {
  if (!raw) return 50
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(Math.floor(n), 200)
}

async function fetchPreflightUtterances(uttLimit: number, sessionReviewStatus: string | undefined) {
  // session_id 필터 (review_status 적용 시 sessions IN-list 사전 로드)
  let sessionIdsFilter: string[] | null = null
  if (sessionReviewStatus && sessionReviewStatus !== 'all') {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('review_status', sessionReviewStatus)
      .limit(5000)
    if (error) throw new Error(`sessions filter: ${error.message}`)
    sessionIdsFilter = (data ?? []).map((r) => r.id as string)
    if (sessionIdsFilter.length === 0) return []
  }

  let query = supabaseAdmin
    .from('utterances')
    .select('session_id, transcript_text')
    .not('transcript_text', 'is', null)
    .limit(uttLimit)
  if (sessionIdsFilter) {
    query = query.in('session_id', sessionIdsFilter)
  }
  const { data, error } = await query
  if (error) throw new Error(`utterances fetch: ${error.message}`)
  return (data ?? []).map((r) => ({
    session_id: String(r.session_id ?? ''),
    transcript_text: typeof r.transcript_text === 'string' ? r.transcript_text : null,
  }))
}

async function fetchConfidenceUtterances(uttLimit: number, sessionReviewStatus: string | undefined) {
  let sessionIdsFilter: string[] | null = null
  if (sessionReviewStatus && sessionReviewStatus !== 'all') {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('review_status', sessionReviewStatus)
      .limit(5000)
    if (error) throw new Error(`sessions filter: ${error.message}`)
    sessionIdsFilter = (data ?? []).map((r) => r.id as string)
    if (sessionIdsFilter.length === 0) return []
  }

  let query = supabaseAdmin
    .from('utterances')
    .select('session_id, label_confidence, emotion_confidence')
    .limit(uttLimit)
  if (sessionIdsFilter) {
    query = query.in('session_id', sessionIdsFilter)
  }
  const { data, error } = await query
  if (error) throw new Error(`utterances fetch: ${error.message}`)
  return (data ?? []).map((r) => ({
    session_id: String(r.session_id ?? ''),
    label_confidence: r.label_confidence as number | string | null | undefined,
    emotion_confidence: r.emotion_confidence as number | string | null | undefined,
  }))
}

adminAnalytics.get('/preflight', async (c) => {
  try {
    const uttLimit = parseLimit(c.req.query('limit'), DEFAULT_UTT_LIMIT, MAX_UTT_LIMIT)
    const topLimit = parseTopLimit(c.req.query('top_limit'))
    const sessionReviewStatus = c.req.query('session_review_status')

    const utts = await fetchPreflightUtterances(uttLimit, sessionReviewStatus)
    const snapshot = buildPreflightSnapshot({ utterances: utts }, { topLimit })

    return c.json({
      endpoint: '/api/admin/analytics/preflight',
      ref_prefix: 'dsys…',
      utt_limit: uttLimit,
      session_review_status: sessionReviewStatus ?? 'all',
      ...snapshot,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return c.json({ error: 'preflight_snapshot_failed', detail: msg }, 500)
  }
})

adminAnalytics.get('/confidence', async (c) => {
  try {
    const uttLimit = parseLimit(c.req.query('limit'), DEFAULT_UTT_LIMIT, MAX_UTT_LIMIT)
    const topLimit = parseTopLimit(c.req.query('top_limit'))
    const sessionReviewStatus = c.req.query('session_review_status')

    const utts = await fetchConfidenceUtterances(uttLimit, sessionReviewStatus)
    const snapshot = buildConfidenceSnapshot({ utterances: utts }, { topLimit })

    return c.json({
      endpoint: '/api/admin/analytics/confidence',
      ref_prefix: 'dsys…',
      utt_limit: uttLimit,
      session_review_status: sessionReviewStatus ?? 'all',
      ...snapshot,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return c.json({ error: 'confidence_snapshot_failed', detail: msg }, 500)
  }
})

export default adminAnalytics
