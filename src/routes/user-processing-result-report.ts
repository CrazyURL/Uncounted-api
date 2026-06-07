// ── User Processing Result Report Route ────────────────────────────────
// 처리 결과 신고 (PII 미마스킹·화자 오류·텍스트 오류) — 처리방침 v1.3 §13.3
//
// 3영업일 검토 의무. admin 큐에 적재 → admin 측 화면에서 처리.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'

const processingResultReport = new Hono()

type ReportType = 'pii_not_masked' | 'wrong_speaker' | 'wrong_text' | 'other'

const REPORT_TYPES: ReportType[] = [
  'pii_not_masked',
  'wrong_speaker',
  'wrong_text',
  'other',
]

// POST /api/user/processing-result-report — 신규 신고 제출
processingResultReport.post('/', authMiddleware, async (c) => {
  const userId = c.get('userId') as string
  const body = getBody<{
    session_id?: string
    utterance_id?: string
    report_type?: ReportType
    user_message?: string
  }>(c)

  if (!body.session_id) {
    return c.json({ error: 'session_id is required' }, 400)
  }
  if (!body.report_type || !REPORT_TYPES.includes(body.report_type)) {
    return c.json(
      { error: `report_type must be one of ${REPORT_TYPES.join(', ')}` },
      400,
    )
  }
  if (body.user_message && body.user_message.length > 2000) {
    return c.json({ error: 'user_message exceeds 2000 chars' }, 400)
  }

  const insert = {
    user_id: userId,
    session_id: body.session_id,
    utterance_id: body.utterance_id ?? null,
    report_type: body.report_type,
    user_message: body.user_message ?? null,
    status: 'pending' as const,
  }

  const { data, error } = await supabaseAdmin
    .from('processing_result_reports')
    .insert(insert)
    .select()
    .single()

  if (error) {
    console.error('[processing-result-report] insert failed:', error)
    return c.json({ error: 'insert failed' }, 500)
  }

  return c.json({ data }, 201)
})

// GET /api/user/processing-result-reports — 본인 신고 이력
processingResultReport.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId') as string
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)

  const { data, error } = await supabaseAdmin
    .from('processing_result_reports')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[processing-result-report] fetch failed:', error)
    return c.json({ error: 'fetch failed' }, 500)
  }

  return c.json({ data })
})

export default processingResultReport
