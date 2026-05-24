// ── Admin PII 후보 판정 API (PII-1B) ──────────────────────────────────
// PII-1A 가 적재한 pii_candidates(needs_human_decision + pending)를 관리자에게 노출하고,
// confirmed/rejected/skipped 판정을 저장한다.
//
// 라우트:
//   GET  /api/admin/pii-candidates              — 후보 큐(기본 needs_human_decision+pending) + 최소 스니펫
//   POST /api/admin/pii-candidates/:id/decision — 관리자 판정 저장(status='decided')
//
// 안전 계약:
//   - 응답에 전체 transcript_text 를 절대 포함하지 않는다. 후보 주변 최소 스니펫만 반환.
//   - candidate_text/snippet 은 서버 로그에 출력하지 않는다(devBodyLogger 가 본 경로를 스킵).
//   - 외부 export / user-facing ZIP / public API 에 스니펫 노출 금지(본 admin 전용 라우트 한정).

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import { buildSnippet, isValidDecision, buildDecisionUpdate } from '../lib/pii/candidateReview.js'
import {
  extractSpan,
  hashNormalized,
  mapPredictedToAnnotationType,
} from '../lib/pii/annotationReview.js'

const adminPiiCandidates = new Hono()

adminPiiCandidates.use('/pii-candidates', authMiddleware)
adminPiiCandidates.use('/pii-candidates', adminMiddleware)
adminPiiCandidates.use('/pii-candidates/*', authMiddleware)
adminPiiCandidates.use('/pii-candidates/*', adminMiddleware)

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

interface CandidateRow {
  id: string
  utterance_id: string
  session_id: string
  predicted_type: string
  confidence: number
  confidence_tier: string
  high_precision_pattern: boolean
  char_start: number | null
  char_end: number | null
  admin_decision: string | null
  admin_selected_type: string | null
  status: string
  created_at: string
}

// ── GET /api/admin/pii-candidates ───────────────────────────────────
adminPiiCandidates.get('/pii-candidates', async (c) => {
  const url = new URL(c.req.url)
  const sessionId = url.searchParams.get('session_id') ?? undefined
  // 기본 큐 = needs_human_decision + pending. tier/status 명시 시 해당 값으로 조회.
  const tier = url.searchParams.get('tier') ?? 'needs_human_decision'
  const status = url.searchParams.get('status') ?? 'pending'
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit') ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  )
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)

  let query = supabaseAdmin
    .from('pii_candidates')
    .select(
      'id, utterance_id, session_id, predicted_type, confidence, confidence_tier, ' +
        'high_precision_pattern, char_start, char_end, admin_decision, admin_selected_type, status, created_at',
      { count: 'exact' },
    )
    .eq('confidence_tier', tier)
    .eq('status', status)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1)

  if (sessionId) {
    query = query.eq('session_id', sessionId)
  }

  const { data, error, count } = await query
  if (error) {
    return c.json({ error: error.message }, 500)
  }

  const rows = (data ?? []) as unknown as CandidateRow[]

  // 스니펫 생성을 위해 transcript_text 를 서버측에서만 조회한다.
  // 전체 transcript 는 응답으로 나가지 않고, 후보 주변 최소 스니펫만 추출 후 폐기한다.
  const uttIds = [...new Set(rows.map((r) => r.utterance_id))]
  const textByUtt = new Map<string, string>()
  if (uttIds.length > 0) {
    const { data: utts, error: uttErr } = await supabaseAdmin
      .from('utterances')
      .select('id, transcript_text')
      .in('id', uttIds)
    if (uttErr) {
      return c.json({ error: uttErr.message }, 500)
    }
    for (const u of (utts ?? []) as Array<{ id: string; transcript_text: string | null }>) {
      if (u.transcript_text) {
        textByUtt.set(u.id, u.transcript_text)
      }
    }
  }

  const items = rows.map((r) => {
    const snip = buildSnippet(textByUtt.get(r.utterance_id), r.char_start, r.char_end)
    return {
      id: r.id,
      utterance_id: r.utterance_id,
      session_id: r.session_id,
      predicted_type: r.predicted_type,
      confidence: r.confidence,
      confidence_tier: r.confidence_tier,
      high_precision_pattern: r.high_precision_pattern,
      status: r.status,
      admin_decision: r.admin_decision,
      admin_selected_type: r.admin_selected_type,
      created_at: r.created_at,
      // 최소 스니펫만(전체 transcript_text 비노출). 미산출 시 null.
      candidate_text: snip?.candidate_text ?? null,
      context_before: snip?.context_before ?? null,
      context_after: snip?.context_after ?? null,
      snippet: snip?.snippet ?? null,
      highlight_start: snip?.highlight_start ?? null,
      highlight_end: snip?.highlight_end ?? null,
    }
  })

  return c.json({
    success: true,
    data: items,
    meta: { total: count ?? items.length, limit, offset },
  })
})

// ── POST /api/admin/pii-candidates/:id/decision ─────────────────────
adminPiiCandidates.post('/pii-candidates/:id{[0-9a-f-]+}/decision', async (c) => {
  const id = c.req.param('id')
  const body = getBody<{ decision?: string; selected_type?: string }>(c)

  if (!isValidDecision(body?.decision)) {
    return c.json({ error: 'invalid decision (confirmed|rejected|skipped)' }, 400)
  }

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('pii_candidates')
    .select('id')
    .eq('id', id)
    .single()

  if (fetchErr || !existing) {
    return c.json({ error: 'candidate not found' }, 404)
  }

  const reviewedBy = c.get('userId') as string
  const update = buildDecisionUpdate(
    body.decision,
    body.selected_type ?? null,
    reviewedBy,
    new Date().toISOString(),
  )

  const { error: updateErr } = await supabaseAdmin
    .from('pii_candidates')
    .update(update)
    .eq('id', id)

  if (updateErr) {
    return c.json({ error: updateErr.message }, 500)
  }

  return c.json({ success: true, data: { id, decision: body.decision, status: 'decided' } })
})

// ── POST /api/admin/pii-candidates/:id/promote ──────────────────────
// PR-P2A-2: confirmed/corrected 후보를 pii_annotations 로 "원자적" 승격.
// candidate verdict 업데이트 + annotation 삽입을 단일 RPC(트랜잭션)로 처리한다.
//   - confirmed → annotation.pii_type 는 predicted_type 을 따른다.
//   - corrected → selected_type 필수, annotation.pii_type 는 selected_type 을 따른다.
//   - rejected/skipped 는 본 엔드포인트 대상이 아니다(기존 /decision 사용).
// 안전: 응답/로그에 원문 PII 미포함. 전사 span 은 hash 산출 후 폐기.
adminPiiCandidates.post('/pii-candidates/:id{[0-9a-f-]+}/promote', async (c) => {
  const id = c.req.param('id')
  const body = getBody<{ decision?: string; selected_type?: string }>(c)
  const decision = body?.decision

  if (decision !== 'confirmed' && decision !== 'corrected') {
    return c.json({ error: 'invalid decision for promote (confirmed|corrected)' }, 400)
  }

  const selectedTypeRaw = typeof body?.selected_type === 'string' ? body.selected_type.trim() : ''
  if (decision === 'corrected' && selectedTypeRaw.length === 0) {
    return c.json({ error: 'selected_type required when decision=corrected' }, 400)
  }

  // 후보 조회(404 판정 + offset/예측유형 확보).
  const { data: candidate, error: fetchErr } = await supabaseAdmin
    .from('pii_candidates')
    .select('id, utterance_id, predicted_type, char_start, char_end')
    .eq('id', id)
    .single()

  if (fetchErr || !candidate) {
    return c.json({ error: 'candidate not found' }, 404)
  }
  const cand = candidate as unknown as {
    id: string
    utterance_id: string
    predicted_type: string
    char_start: number | null
    char_end: number | null
  }

  // confirmed → predicted_type, corrected → selected_type 를 annotation enum 으로 매핑.
  const sourceTypeLabel = decision === 'corrected' ? selectedTypeRaw : cand.predicted_type
  const annotationPiiType = mapPredictedToAnnotationType(sourceTypeLabel)
  if (!annotationPiiType) {
    return c.json({ error: `unmappable pii type: ${decision === 'corrected' ? 'selected_type' : 'predicted_type'}` }, 400)
  }

  // 후보에 기록할 정정 유형(한글 라벨). confirmed 는 predicted_type 을 그대로 확정으로 기록.
  const adminSelectedType = decision === 'corrected' ? selectedTypeRaw : cand.predicted_type

  // 전사 span → 단방향 hash (원문 미저장/미반환). offset 누락 시 null 허용.
  let normalizedTextHash: string | null = null
  if (typeof cand.char_start === 'number' && typeof cand.char_end === 'number') {
    const { data: utt, error: uttErr } = await supabaseAdmin
      .from('utterances')
      .select('transcript_text')
      .eq('id', cand.utterance_id)
      .single()
    if (uttErr) {
      return c.json({ error: uttErr.message }, 500)
    }
    const text = (utt as { transcript_text: string | null } | null)?.transcript_text ?? null
    const span = extractSpan(text, cand.char_start, cand.char_end)
    normalizedTextHash = hashNormalized(span)
  }

  const reviewedBy = c.get('userId') as string
  const reviewedAt = new Date().toISOString()

  const { data: annotationId, error: rpcErr } = await supabaseAdmin.rpc(
    'promote_pii_candidate_to_annotation',
    {
      p_candidate_id: id,
      p_decision: decision,
      p_admin_selected_type: adminSelectedType,
      p_annotation_pii_type: annotationPiiType,
      p_normalized_text_hash: normalizedTextHash,
      p_reviewed_by: reviewedBy,
      p_reviewed_at: reviewedAt,
    },
  )

  if (rpcErr) {
    return c.json({ error: rpcErr.message }, 500)
  }

  return c.json({
    success: true,
    data: {
      id,
      decision,
      status: 'decided',
      pii_type: annotationPiiType,
      annotation_id: annotationId ?? null,
    },
  })
})

export default adminPiiCandidates
