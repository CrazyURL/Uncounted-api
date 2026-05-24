// ── Admin 확정 PII 라벨 API (PR-P2A-1: DDL + 기본 골격) ──────────────
// pii_annotations(확정 PII 라벨)를 조회하고, 관리자가 전사 검수 중 직접 발견한 PII 를
// 수동 등록(source=admin_manual)한다.
//
// 라우트:
//   GET  /api/admin/pii-annotations          — 확정 라벨 목록(필터: session_id/source/pii_type/action_status)
//   POST /api/admin/pii-annotations          — admin_manual 수동 등록(최소 API)
//
// 범위 한정(PR-P2A-1):
//   - candidate 승격(detector_candidate, candidate_id 링크)은 본 PR 에서 구현하지 않는다 → PR-P2A-2.
//   - 따라서 POST 는 source=admin_manual 만 생성한다(candidate_id 항상 null).
//
// 안전 계약:
//   - 요청/응답/로그 어디에도 raw PII text / snippet 을 포함하지 않는다.
//   - span 원문은 서버측에서 transcript_text 로부터 추출 → hash 산출 후 폐기. 저장은 hash 만.
//   - 전체 transcript_text 를 응답으로 내보내지 않는다.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import {
  isValidPiiType,
  isValidActionStatus,
  isValidSource,
  extractSpan,
  hashNormalized,
  buildManualAnnotationInsert,
} from '../lib/pii/annotationReview.js'

const adminPiiAnnotations = new Hono()

adminPiiAnnotations.use('/pii-annotations', authMiddleware)
adminPiiAnnotations.use('/pii-annotations', adminMiddleware)
adminPiiAnnotations.use('/pii-annotations/*', authMiddleware)
adminPiiAnnotations.use('/pii-annotations/*', adminMiddleware)

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

// 응답 컬럼: 원문/스니펫 없음. offset 은 internal review 포인터(admin 전용).
const SELECT_COLS =
  'id, utterance_id, session_id, source, candidate_id, pii_type, char_start, char_end, ' +
  'normalized_text_hash, action_status, reviewed_by, reviewed_at, note, created_at'

// ── GET /api/admin/pii-annotations ──────────────────────────────────
adminPiiAnnotations.get('/pii-annotations', async (c) => {
  const url = new URL(c.req.url)
  const sessionId = url.searchParams.get('session_id') ?? undefined
  const source = url.searchParams.get('source') ?? undefined
  const piiType = url.searchParams.get('pii_type') ?? undefined
  const actionStatus = url.searchParams.get('action_status') ?? undefined
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit') ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  )
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)

  // 알 수 없는 enum 필터는 400(조용한 빈 결과 방지).
  if (source !== undefined && !isValidSource(source)) {
    return c.json({ error: 'invalid source' }, 400)
  }
  if (piiType !== undefined && !isValidPiiType(piiType)) {
    return c.json({ error: 'invalid pii_type' }, 400)
  }
  if (actionStatus !== undefined && !isValidActionStatus(actionStatus)) {
    return c.json({ error: 'invalid action_status' }, 400)
  }

  let query = supabaseAdmin
    .from('pii_annotations')
    .select(SELECT_COLS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (sessionId) query = query.eq('session_id', sessionId)
  if (source) query = query.eq('source', source)
  if (piiType) query = query.eq('pii_type', piiType)
  if (actionStatus) query = query.eq('action_status', actionStatus)

  const { data, error, count } = await query
  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json({
    success: true,
    data: data ?? [],
    meta: { total: count ?? (data?.length ?? 0), limit, offset },
  })
})

// ── POST /api/admin/pii-annotations ─────────────────────────────────
// body: { utterance_id, char_start, char_end, pii_type, note? }
//   - session_id 는 utterance 에서 서버측 도출(클라이언트 미신뢰).
//   - normalized_text_hash 는 transcript_text 의 span 으로 서버측 산출(원문 미저장).
adminPiiAnnotations.post('/pii-annotations', async (c) => {
  const body = getBody<{
    utterance_id?: string
    char_start?: number
    char_end?: number
    pii_type?: string
    note?: string
  }>(c)

  if (!body?.utterance_id || typeof body.utterance_id !== 'string') {
    return c.json({ error: 'utterance_id required' }, 400)
  }
  if (!isValidPiiType(body.pii_type)) {
    return c.json(
      { error: 'invalid pii_type (name|phone|account|address|ip|email|organization|resident_id|other)' },
      400,
    )
  }
  const charStart = typeof body.char_start === 'number' ? body.char_start : null
  const charEnd = typeof body.char_end === 'number' ? body.char_end : null
  if (charStart === null || charEnd === null || charStart >= charEnd) {
    return c.json({ error: 'char_start/char_end required (char_start < char_end)' }, 400)
  }

  // 발화 존재 확인 + session_id/transcript_text 서버측 조회.
  const { data: utt, error: uttErr } = await supabaseAdmin
    .from('utterances')
    .select('id, session_id, transcript_text')
    .eq('id', body.utterance_id)
    .single()

  if (uttErr || !utt) {
    return c.json({ error: 'utterance not found' }, 404)
  }
  const utterance = utt as { id: string; session_id: string; transcript_text: string | null }

  // span 원문은 hash 산출에만 쓰고 폐기. 저장/반환/로그 금지.
  const span = extractSpan(utterance.transcript_text, charStart, charEnd)
  const normalizedTextHash = hashNormalized(span)

  const reviewedBy = c.get('userId') as string
  const insertRow = buildManualAnnotationInsert(
    {
      utteranceId: utterance.id,
      sessionId: utterance.session_id,
      piiType: body.pii_type,
      charStart,
      charEnd,
      normalizedTextHash,
      reviewedBy,
      note: typeof body.note === 'string' && body.note.length > 0 ? body.note : null,
    },
    new Date().toISOString(),
  )

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('pii_annotations')
    .insert(insertRow)
    .select(SELECT_COLS)
    .single()

  if (insErr) {
    // dedup(uniq_pii_annotations_dedup) 위반 = 같은 발화·유형·구간 라벨 중복.
    if (insErr.code === '23505') {
      return c.json({ error: 'annotation already exists for this span', code: 'duplicate' }, 409)
    }
    return c.json({ error: insErr.message }, 500)
  }

  return c.json({ success: true, data: inserted }, 201)
})

export default adminPiiAnnotations
