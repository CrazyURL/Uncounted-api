// ── Admin Ledger & Delivery Routes ────────────────────────────────────
// Ledger Entries + Delivery Records
// admin-exports.ts에서 분리 (파일 크기 제한 준수)

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'

const adminLedger = new Hono()

adminLedger.use('/*', authMiddleware)
adminLedger.use('/*', adminMiddleware)

// ── Ledger Entries ──────────────────────────────────────────────────────

adminLedger.get('/ledger-entries', async (c) => {
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

adminLedger.post('/ledger-entries', async (c) => {
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

adminLedger.post('/ledger-entries/update-status', async (c) => {
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

adminLedger.post('/ledger-entries/confirm-job', async (c) => {
  const { exportJobId, totalPayment } = getBody<{
    exportJobId: string
    totalPayment: number
  }>(c)

  if (!exportJobId || totalPayment == null) {
    return c.json({ error: 'exportJobId and totalPayment are required' }, 400)
  }

  try {
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

adminLedger.get('/delivery-records', async (c) => {
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

adminLedger.post('/delivery-records', async (c) => {
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

export default adminLedger
