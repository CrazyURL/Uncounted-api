// ── User Automated Decision Appeal Route ───────────────────────────────
// 자동화된 결정 거부·설명 요구 — 처리방침 v1.3 §14.5
//
// 사용자가 PII 마스킹·화자분리·품질 등급·적격성 판정 등 자동화된 결정에
// 거부(reject=사람 개입 요청) 또는 설명 요구(explain) 를 제출 → admin 큐에 적재.
// admin 10영업일 회신 의무.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'

const automatedDecisionAppeal = new Hono()

type AppealType = 'reject' | 'explain'
type DecisionArea =
  | 'pii_masking'
  | 'speaker_diarization'
  | 'quality_grade'
  | 'dataset_eligibility'

const APPEAL_TYPES: AppealType[] = ['reject', 'explain']
const DECISION_AREAS: DecisionArea[] = [
  'pii_masking',
  'speaker_diarization',
  'quality_grade',
  'dataset_eligibility',
]

// POST /api/user/automated-decision-appeal — 신규 요청 제출
automatedDecisionAppeal.post('/', authMiddleware, async (c) => {
  const userId = c.get('userId') as string
  const body = getBody<{
    appeal_type?: AppealType
    decision_area?: DecisionArea
    session_id?: string
    user_message?: string
  }>(c)

  if (!body.appeal_type || !APPEAL_TYPES.includes(body.appeal_type)) {
    return c.json({ error: 'appeal_type must be reject or explain' }, 400)
  }
  if (!body.decision_area || !DECISION_AREAS.includes(body.decision_area)) {
    return c.json(
      { error: `decision_area must be one of ${DECISION_AREAS.join(', ')}` },
      400,
    )
  }
  if (body.user_message && body.user_message.length > 2000) {
    return c.json({ error: 'user_message exceeds 2000 chars' }, 400)
  }

  const insert = {
    user_id: userId,
    session_id: body.session_id ?? null,
    appeal_type: body.appeal_type,
    decision_area: body.decision_area,
    user_message: body.user_message ?? null,
    status: 'pending' as const,
  }

  const { data, error } = await supabaseAdmin
    .from('automated_decision_appeals')
    .insert(insert)
    .select()
    .single()

  if (error) {
    console.error('[automated-decision-appeal] insert failed:', error)
    return c.json({ error: 'insert failed' }, 500)
  }

  return c.json({ data }, 201)
})

// GET /api/user/automated-decision-appeals — 본인 요청 이력
automatedDecisionAppeal.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId') as string
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)

  const { data, error } = await supabaseAdmin
    .from('automated_decision_appeals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[automated-decision-appeal] fetch failed:', error)
    return c.json({ error: 'fetch failed' }, 500)
  }

  return c.json({ data })
})

export default automatedDecisionAppeal
