// ── Admin Appeals & Reports Queue Routes ──────────────────────────────
// 처리방침 v1.3 §14.5 자동화된 결정 거부 큐 + §13.3 처리 결과 신고 큐
//
// admin 검토 화면용. 10영업일 / 3영업일 SLA 추적.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'

const adminAppealsQueue = new Hono()

type QueueStatus = 'pending' | 'in_review' | 'resolved' | 'rejected'
const QUEUE_STATUSES: QueueStatus[] = ['pending', 'in_review', 'resolved', 'rejected']

// ── Automated Decision Appeals (10영업일 SLA) ──────────────────────────

// GET /api/admin/automated-decision-appeals
adminAppealsQueue.get('/automated-decision-appeals', authMiddleware, adminMiddleware, async (c) => {
  const status = (c.req.query('status') ?? 'pending') as QueueStatus
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)

  if (!QUEUE_STATUSES.includes(status)) {
    return c.json({ error: `status must be one of ${QUEUE_STATUSES.join(', ')}` }, 400)
  }

  const { data, error } = await supabaseAdmin
    .from('automated_decision_appeals')
    .select('*, users:user_id (id, email)')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[admin-appeals] fetch failed:', error)
    return c.json({ error: 'fetch failed' }, 500)
  }

  return c.json({ data })
})

// PATCH /api/admin/automated-decision-appeals/:id
adminAppealsQueue.patch('/automated-decision-appeals/:id', authMiddleware, adminMiddleware, async (c) => {
  const adminUserId = c.get('userId') as string
  const id = c.req.param('id')
  const body = getBody<{
    status?: QueueStatus
    admin_response?: string
  }>(c)

  if (!body.status || !['in_review', 'resolved', 'rejected'].includes(body.status)) {
    return c.json({ error: 'status must be in_review / resolved / rejected' }, 400)
  }
  if (body.admin_response && body.admin_response.length > 4000) {
    return c.json({ error: 'admin_response exceeds 4000 chars' }, 400)
  }

  const updates: Record<string, unknown> = {
    status: body.status,
    admin_response: body.admin_response ?? null,
    resolved_by: adminUserId,
    updated_at: new Date().toISOString(),
  }
  if (body.status === 'resolved' || body.status === 'rejected') {
    updates.resolved_at = new Date().toISOString()
  }

  const { data, error } = await supabaseAdmin
    .from('automated_decision_appeals')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    console.error('[admin-appeals] update failed:', error)
    return c.json({ error: 'update failed' }, 500)
  }

  return c.json({ data })
})

// ── Processing Result Reports (3영업일 SLA) ────────────────────────────

// GET /api/admin/processing-result-reports
adminAppealsQueue.get('/processing-result-reports', authMiddleware, adminMiddleware, async (c) => {
  const status = (c.req.query('status') ?? 'pending') as QueueStatus
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)

  if (!QUEUE_STATUSES.includes(status)) {
    return c.json({ error: `status must be one of ${QUEUE_STATUSES.join(', ')}` }, 400)
  }

  const { data, error } = await supabaseAdmin
    .from('processing_result_reports')
    .select('*, users:user_id (id, email)')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[admin-reports] fetch failed:', error)
    return c.json({ error: 'fetch failed' }, 500)
  }

  return c.json({ data })
})

// PATCH /api/admin/processing-result-reports/:id
adminAppealsQueue.patch('/processing-result-reports/:id', authMiddleware, adminMiddleware, async (c) => {
  const adminUserId = c.get('userId') as string
  const id = c.req.param('id')
  const body = getBody<{
    status?: QueueStatus
    admin_response?: string
  }>(c)

  if (!body.status || !['in_review', 'resolved', 'rejected'].includes(body.status)) {
    return c.json({ error: 'status must be in_review / resolved / rejected' }, 400)
  }
  if (body.admin_response && body.admin_response.length > 4000) {
    return c.json({ error: 'admin_response exceeds 4000 chars' }, 400)
  }

  const updates: Record<string, unknown> = {
    status: body.status,
    admin_response: body.admin_response ?? null,
    resolved_by: adminUserId,
    updated_at: new Date().toISOString(),
  }
  if (body.status === 'resolved' || body.status === 'rejected') {
    updates.resolved_at = new Date().toISOString()
  }

  const { data, error } = await supabaseAdmin
    .from('processing_result_reports')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    console.error('[admin-reports] update failed:', error)
    return c.json({ error: 'update failed' }, 500)
  }

  return c.json({ data })
})

export default adminAppealsQueue
