// ── Admin API Routes ───────────────────────────────────────────────────
// 관리자 페이지 전용 API (Clients, DeliveryProfiles, SKU Rules, Export Jobs, Billable Units)

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase'
import { authMiddleware, getBody } from '../lib/middleware'
import { encryptId } from '../lib/crypto'

const admin = new Hono()

// 모든 라우트에 인증 필수 (추후 관리자 권한 체크 추가 가능)
admin.use('/*', authMiddleware)

// ── Admin Me ─────────────────────────────────────────────────────────────

admin.get('/me', async (c) => {
  const userId = c.get('userId')

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.admin.getUserById(userId)

    if (error || !user) return c.json({ error: 'forbidden' }, 403)

    if (user.app_metadata?.role !== 'admin') {
      return c.json({ error: 'forbidden' }, 403)
    }

    return c.json({ user: { id: encryptId(user.id), email: encryptId(user.email!) } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Clients ─────────────────────────────────────────────────────────────

admin.get('/clients', async (c) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/clients', async (c) => {
  const client = getBody(c)

  try {
    const { error } = await supabaseAdmin.from('clients').upsert(client)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.delete('/clients/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { error } = await supabaseAdmin.from('clients').delete().eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Delivery Profiles ───────────────────────────────────────────────────

admin.get('/delivery-profiles', async (c) => {
  const clientId = c.req.query('clientId')

  try {
    let query = supabaseAdmin
      .from('delivery_profiles')
      .select('*')
      .order('created_at', { ascending: false })

    if (clientId) query = query.eq('client_id', clientId)

    const { data, error } = await query
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/delivery-profiles', async (c) => {
  const profile = getBody(c)

  try {
    const { error } = await supabaseAdmin.from('delivery_profiles').upsert(profile)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.delete('/delivery-profiles/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { error } = await supabaseAdmin.from('delivery_profiles').delete().eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Client SKU Rules ────────────────────────────────────────────────────

admin.get('/client-sku-rules', async (c) => {
  const clientId = c.req.query('clientId')

  if (!clientId) {
    return c.json({ error: 'clientId query parameter is required' }, 400)
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('client_sku_rules')
      .select('*')
      .eq('client_id', clientId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/client-sku-rules', async (c) => {
  const rule = getBody(c)

  try {
    const { error } = await supabaseAdmin.from('client_sku_rules').upsert(rule)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.delete('/client-sku-rules/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { error } = await supabaseAdmin.from('client_sku_rules').delete().eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── SKU Presets ─────────────────────────────────────────────────────────

admin.get('/sku-presets', async (c) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('sku_presets')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/sku-presets', async (c) => {
  const preset = getBody(c)

  try {
    const { error } = await supabaseAdmin.from('sku_presets').upsert(preset)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.delete('/sku-presets/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { error } = await supabaseAdmin.from('sku_presets').delete().eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Export Jobs ─────────────────────────────────────────────────────────

admin.get('/export-jobs', async (c) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('export_jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.get('/export-jobs/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { data, error } = await supabaseAdmin
      .from('export_jobs')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ data: null })
      }
      return c.json({ error: error.message }, 500)
    }

    return c.json({ data })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/export-jobs', async (c) => {
  const job = getBody(c)

  try {
    const { error } = await supabaseAdmin.from('export_jobs').upsert(job)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/export-jobs/:id/logs', async (c) => {
  const id = c.req.param('id')
  const { log } = getBody<{ log: unknown }>(c)

  try {
    // 기존 job 조회
    const { data: job, error: fetchError } = await supabaseAdmin
      .from('export_jobs')
      .select('logs')
      .eq('id', id)
      .single()

    if (fetchError || !job) {
      return c.json({ error: 'Job not found' }, 404)
    }

    // logs 배열에 추가
    const logs = Array.isArray(job.logs) ? [...job.logs, log] : [log]

    const { error } = await supabaseAdmin
      .from('export_jobs')
      .update({ logs })
      .eq('id', id)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.delete('/export-jobs/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { error } = await supabaseAdmin.from('export_jobs').delete().eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Billable Units ──────────────────────────────────────────────────────

admin.get('/billable-units', async (c) => {
  const qualityGrade = c.req.query('qualityGrade')?.split(',')
  const qualityTier = c.req.query('qualityTier')?.split(',')
  const consentStatus = c.req.query('consentStatus')
  const lockStatus = c.req.query('lockStatus')
  const userId = c.req.query('userId')
  const dateFrom = c.req.query('dateFrom')
  const dateTo = c.req.query('dateTo')

  try {
    const PAGE = 1000
    const all: any[] = []
    let from = 0

    while (true) {
      let query = supabaseAdmin
        .from('billable_units')
        .select('*')
        .order('session_date', { ascending: false })
        .range(from, from + PAGE - 1)

      if (qualityGrade?.length) query = query.in('quality_grade', qualityGrade)
      if (qualityTier?.length) query = query.in('quality_tier', qualityTier)
      if (consentStatus) query = query.eq('consent_status', consentStatus)
      if (lockStatus) query = query.eq('lock_status', lockStatus)
      if (userId) query = query.eq('user_id', userId)
      if (dateFrom && dateTo) {
        query = query.gte('session_date', dateFrom).lte('session_date', dateTo)
      }

      const { data, error } = await query
      if (error) break
      if (!data || data.length === 0) break

      all.push(...data)
      if (data.length < PAGE) break
      from += PAGE
    }

    return c.json({ data: all })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/billable-units', async (c) => {
  const { units } = getBody<{ units: any[] }>(c)

  if (!Array.isArray(units) || units.length === 0) {
    return c.json({ error: 'Units array is required' }, 400)
  }

  try {
    const BATCH = 500
    for (let i = 0; i < units.length; i += BATCH) {
      const batch = units.slice(i, i + BATCH)
      const { error } = await supabaseAdmin.from('billable_units').upsert(batch)
      if (error) {
        return c.json({ error: error.message }, 500)
      }
    }

    return c.json({ data: { count: units.length, success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/billable-units/lock', async (c) => {
  const { unitIds, jobId } = getBody<{ unitIds: string[]; jobId: string }>(c)

  if (!Array.isArray(unitIds) || !jobId) {
    return c.json({ error: 'unitIds and jobId are required' }, 400)
  }

  try {
    const BATCH = 500
    let locked = 0

    for (let i = 0; i < unitIds.length; i += BATCH) {
      const batch = unitIds.slice(i, i + BATCH)
      const { error, count } = await supabaseAdmin
        .from('billable_units')
        .update({ lock_status: 'locked_for_job', locked_by_job_id: jobId })
        .in('id', batch)
        .eq('lock_status', 'available')

      if (error) break
      locked += count ?? batch.length
    }

    return c.json({ data: { locked } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/billable-units/unlock', async (c) => {
  const { jobId } = getBody<{ jobId: string }>(c)

  if (!jobId) {
    return c.json({ error: 'jobId is required' }, 400)
  }

  try {
    const { error } = await supabaseAdmin
      .from('billable_units')
      .update({ lock_status: 'available', locked_by_job_id: null })
      .eq('locked_by_job_id', jobId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/billable-units/mark-delivered', async (c) => {
  const { jobId } = getBody<{ jobId: string }>(c)

  if (!jobId) {
    return c.json({ error: 'jobId is required' }, 400)
  }

  try {
    const { error } = await supabaseAdmin
      .from('billable_units')
      .update({ lock_status: 'delivered' })
      .eq('locked_by_job_id', jobId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Sessions (Admin) ──────────────────────────────────────────────────

/**
 * GET /admin/sessions
 * 전체 세션 조회 (어드민 전용, user_id 필터 없음)
 * Query params:
 *   - limit?: number (default 1000, max 2000)
 *   - offset?: number (default 0)
 */
admin.get('/sessions', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 1000), 2000)
  const offset = Number(c.req.query('offset') ?? 0)

  try {
    const { data, error, count } = await supabaseAdmin
      .from('sessions')
      .select('*', { count: 'exact' })
      .order('date', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [], count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Transcripts (Admin) ──────────────────────────────────────────────────

/**
 * GET /admin/transcripts
 * 전체 전사 데이터 조회 (어드민 전용, user_id 필터 없음)
 * Query params:
 *   - limit?: number (default 500, max 1000)
 *   - offset?: number (default 0)
 */
admin.get('/transcripts', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 500), 1000)
  const offset = Number(c.req.query('offset') ?? 0)

  try {
    const { data, error, count } = await supabaseAdmin
      .from('transcripts')
      .select('session_id, user_id, text, summary, created_at, words', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return c.json({ error: error.message }, 500)

    const result = (data ?? []).map((row) => ({
      sessionId: row.session_id,
      userId: row.user_id,
      text: row.text,
      summary: row.summary ?? undefined,
      words: row.words ?? undefined,
      createdAt: row.created_at,
    }))

    return c.json({ data: result, count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Ledger Entries ──────────────────────────────────────────────────────

admin.get('/ledger-entries', async (c) => {
  const userId = c.req.query('userId')
  const status = c.req.query('status')
  const exportJobId = c.req.query('exportJobId')
  const buIds = c.req.query('buIds')?.split(',').filter(Boolean)

  try {
    const PAGE = 1000
    const all: any[] = []
    let from = 0

    while (true) {
      let query = supabaseAdmin
        .from('user_asset_ledger')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1)

      if (userId) query = query.eq('user_id', userId)
      if (status) query = query.eq('status', status)
      if (exportJobId) query = query.eq('export_job_id', exportJobId)
      if (buIds?.length) query = query.in('bu_id', buIds)

      const { data, error } = await query
      if (error) { console.warn('ledger-entries error:', error.message); break }
      if (!data || data.length === 0) break

      all.push(...data)
      if (data.length < PAGE) break
      from += PAGE
    }

    return c.json({ data: all })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/ledger-entries', async (c) => {
  const { entries } = getBody<{ entries: any[] }>(c)

  if (!Array.isArray(entries) || entries.length === 0) {
    return c.json({ error: 'entries array is required' }, 400)
  }

  try {
    const BATCH = 500
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH)
      const { error } = await supabaseAdmin.from('user_asset_ledger').upsert(batch)
      if (error) return c.json({ error: error.message }, 500)
    }
    return c.json({ data: { count: entries.length, success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/ledger-entries/update-status', async (c) => {
  const { ids, status, confirmedAmount } = getBody<{
    ids: string[]
    status: string
    confirmedAmount?: number
  }>(c)

  if (!Array.isArray(ids) || ids.length === 0 || !status) {
    return c.json({ error: 'ids and status are required' }, 400)
  }

  try {
    const now = new Date().toISOString()
    const updateFields: Record<string, unknown> = { status }

    if (status === 'confirmed') {
      updateFields.confirmed_at = now
      if (confirmedAmount != null) updateFields.amount_confirmed = confirmedAmount
    } else if (status === 'withdrawable') {
      updateFields.withdrawable_at = now
    } else if (status === 'paid') {
      updateFields.paid_at = now
    }

    const BATCH = 500
    let updated = 0
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH)
      const { error, count } = await supabaseAdmin
        .from('user_asset_ledger')
        .update(updateFields)
        .in('id', batch)
      if (error) return c.json({ error: error.message }, 500)
      updated += count ?? batch.length
    }

    return c.json({ data: { updated } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/ledger-entries/confirm-job', async (c) => {
  const { exportJobId, totalPayment } = getBody<{
    exportJobId: string
    totalPayment: number
  }>(c)

  if (!exportJobId || totalPayment == null) {
    return c.json({ error: 'exportJobId and totalPayment are required' }, 400)
  }

  try {
    // estimated 상태인 항목 조회
    const { data: rows, error: fetchError } = await supabaseAdmin
      .from('user_asset_ledger')
      .select('id, amount_high')
      .eq('export_job_id', exportJobId)
      .eq('status', 'estimated')

    if (fetchError) return c.json({ error: fetchError.message }, 500)
    if (!rows || rows.length === 0) return c.json({ data: { confirmed: 0 } })

    const totalHigh = rows.reduce((s: number, r: any) => s + (r.amount_high ?? 0), 0)
    if (totalHigh === 0) return c.json({ data: { confirmed: 0 } })

    const now = new Date().toISOString()
    let confirmed = 0

    for (const row of rows) {
      const ratio = (row.amount_high ?? 0) / totalHigh
      const amount = Math.round(totalPayment * ratio)
      const { error } = await supabaseAdmin
        .from('user_asset_ledger')
        .update({ amount_confirmed: amount, status: 'confirmed', confirmed_at: now })
        .eq('id', row.id)
      if (!error) confirmed++
    }

    return c.json({ data: { confirmed } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Delivery Records ─────────────────────────────────────────────────────

admin.get('/delivery-records', async (c) => {
  const clientId = c.req.query('clientId')

  if (!clientId) {
    return c.json({ error: 'clientId query parameter is required' }, 400)
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('delivery_records')
      .select('*')
      .eq('client_id', clientId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/delivery-records', async (c) => {
  const { buIds, clientId, exportJobId } = getBody<{
    buIds: string[]
    clientId: string
    exportJobId: string
  }>(c)

  if (!Array.isArray(buIds) || !clientId || !exportJobId) {
    return c.json({ error: 'buIds, clientId, exportJobId are required' }, 400)
  }

  try {
    const now = new Date().toISOString()
    const BATCH = 500
    for (let i = 0; i < buIds.length; i += BATCH) {
      const batch = buIds.slice(i, i + BATCH).map((buId) => ({
        bu_id: buId,
        client_id: clientId,
        export_job_id: exportJobId,
        delivered_at: now,
      }))
      const { error } = await supabaseAdmin
        .from('delivery_records')
        .upsert(batch, { onConflict: 'bu_id,client_id' })
      if (error) return c.json({ error: error.message }, 500)
    }

    return c.json({ data: { count: buIds.length, success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Reset All ───────────────────────────────────────────────────────────

admin.delete('/reset-all', async (c) => {
  const TABLES = [
    'sessions',
    'export_jobs',
    'billable_units',
    'error_logs',
    'funnel_events',
  ]

  const result: Record<string, number | string> = {}

  for (const table of TABLES) {
    try {
      const { error, count } = await supabaseAdmin
        .from(table)
        .delete({ count: 'exact' })
        .neq('id', '___impossible___')

      result[table] = error ? `ERROR: ${error.message}` : (count ?? 0)
    } catch (err: any) {
      result[table] = `ERROR: ${err.message}`
    }
  }

  return c.json({ data: { tables: result } })
})

export default admin
