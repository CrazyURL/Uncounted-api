// ── Admin Export Routes ────────────────────────────────────────────────
// Export Jobs, Billable Units, Ledger Entries, Delivery Records
// admin.ts에서 분리된 익스포트 관련 라우트

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import { encryptId } from '../lib/crypto.js'
import { getSkuInventory } from '../lib/export/inventoryService.js'
import { previewPool, poolAndRankBUs } from '../lib/export/poolingService.js'
import { segmentBulk } from '../lib/export/utteranceSegmentationService.js'
import { analyzeBulk } from '../lib/export/qualityMetricsService.js'
import {
  getUtterancesByExportRequest,
  updateUtteranceStatus,
  saveUtterances,
} from '../lib/export/utteranceRepository.js'
import { getSignedUrl } from '../lib/s3.js'
import { buildPackage } from '../lib/export/packageBuilder.js'
import { getSignedDownloadUrl } from '../lib/export/downloadService.js'

const adminExports = new Hono()

// 모든 라우트에 인증 + 관리자 권한 필수
adminExports.use('/*', authMiddleware)
adminExports.use('/*', adminMiddleware)

// ── Billable Unit Row → camelCase 변환 ─────────────────────────────────

function billableUnitFromRow(row: Record<string, unknown>) {
  const rawId = row.id as string
  const rawSessionId = (row.session_id ?? row.sessionId) as string
  const rawUserId = (row.user_id ?? row.userId) as string

  return {
    id:               encryptId(rawId),
    sessionId:        rawUserId ? encryptId(rawSessionId) : null,
    minuteIndex:      (row.minute_index ?? row.minuteIndex) as number,
    effectiveSeconds: Number(row.effective_seconds ?? row.effectiveSeconds ?? 0),
    qualityGrade:     ((row.quality_grade ?? row.qualityGrade) as 'A' | 'B' | 'C') ?? 'C',
    qaScore:          Number(row.qa_score ?? row.qaScore ?? 0),
    qualityTier:      ((row.quality_tier ?? row.qualityTier) as string) ?? 'basic',
    labelSource:      ((row.label_source ?? row.labelSource) as string) ?? null,
    hasLabels:        ((row.has_labels ?? row.hasLabels) as boolean) ?? false,
    consentStatus:    ((row.consent_status ?? row.consentStatus) as string) ?? 'PRIVATE',
    piiStatus:        ((row.pii_status ?? row.piiStatus) as string) ?? 'CLEAR',
    lockStatus:       ((row.lock_status ?? row.lockStatus) as string) ?? 'available',
    lockedByJobId:    ((row.locked_by_job_id ?? row.lockedByJobId) as string) ?? null,
    sessionDate:      ((row.session_date ?? row.sessionDate) as string) ?? '',
    userId:           rawUserId ? encryptId(rawUserId) : null,
    sourceSessionIds: ((row.source_session_ids ?? row.sourceSessionIds) as string[]) ?? undefined,
    deviceContext:    ((row.device_context ?? row.deviceContext) as any) ?? undefined,
  }
}

// ── Export Jobs ─────────────────────────────────────────────────────────

adminExports.get('/export-jobs', async (c) => {
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

adminExports.get('/export-jobs/:id', async (c) => {
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

adminExports.post('/export-jobs', async (c) => {
  const job = getBody(c)

  try {
    const { error } = await supabaseAdmin.from('export_jobs').upsert(job)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

adminExports.post('/export-jobs/:id/logs', async (c) => {
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

adminExports.delete('/export-jobs/:id', async (c) => {
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

adminExports.get('/billable-units', async (c) => {
  const qualityGrade = c.req.query('qualityGrade')?.split(',')
  const qualityTier = c.req.query('qualityTier')?.split(',')
  const consentStatus = c.req.query('consentStatus')
  const lockStatus = c.req.query('lockStatus')
  const userId = c.req.query('userId')
  const dateFrom = c.req.query('dateFrom')
  const dateTo = c.req.query('dateTo')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10), 1000)
  const offset = parseInt(c.req.query('offset') ?? '0', 10)

  try {
    let query = supabaseAdmin
      .from('billable_units')
      .select('*', { count: 'exact' })
      .order('session_date', { ascending: false })
      .range(offset, offset + limit - 1)

    if (qualityGrade?.length) query = query.in('quality_grade', qualityGrade)
    if (qualityTier?.length) query = query.in('quality_tier', qualityTier)
    if (consentStatus) query = query.eq('consent_status', consentStatus)
    if (lockStatus) query = query.eq('lock_status', lockStatus)
    if (userId) query = query.eq('user_id', userId)
    if (dateFrom && dateTo) {
      query = query.gte('session_date', dateFrom).lte('session_date', dateTo)
    }

    const { data, error, count } = await query
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: (data ?? []).map(billableUnitFromRow), count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

adminExports.post('/billable-units', async (c) => {
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

adminExports.post('/billable-units/lock', async (c) => {
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

adminExports.post('/billable-units/unlock', async (c) => {
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

adminExports.post('/billable-units/mark-delivered', async (c) => {
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

// ── Inventory ───────────────────────────────────────────────────────────

adminExports.get('/inventory', async (c) => {
  try {
    const data = await getSkuInventory()
    return c.json({ data })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// ── Export Request: Preview ──────────────────────────────────────────────

adminExports.get('/export-requests/:id/preview', async (c) => {
  const id = c.req.param('id')

  try {
    const { data: job, error: jobError } = await supabaseAdmin
      .from('export_jobs')
      .select('*')
      .eq('id', id)
      .single()

    if (jobError || !job) {
      return c.json({ error: 'Export job not found' }, 404)
    }

    const filters = (job.filters ?? {}) as Record<string, unknown>
    const preview = await previewPool(job.sku_id, {
      qualityGrades: (filters.qualityGrades as string[]) ?? undefined,
      dateFrom: (filters.dateFrom as string) ?? undefined,
      dateTo: (filters.dateTo as string) ?? undefined,
      requireConsent: true,
      requirePiiCleaned: true,
      minQaScore: 50,
      requireTranscript: true,
    })

    const requestedBUs = job.requested_units as number
    const canFulfill = preview.totalEligible >= requestedBUs
    const shortfall = canFulfill ? undefined : requestedBUs - preview.totalEligible
    // Rough estimate: ~0.96MB per BU minute of 16kHz mono WAV
    const estimatedPackageSizeMb = Math.round(Math.min(preview.totalEligible, requestedBUs) * 0.96)

    return c.json({
      data: {
        canFulfill,
        availableBUs: preview.totalEligible,
        requestedBUs,
        shortfall,
        qualityDistribution: preview.qualityDistribution,
        speakerCount: preview.speakerCount,
        labelCoverage: preview.labelCoverage,
        avgQualityScore: preview.avgQualityScore,
        totalHours: preview.totalHours,
        estimatedPackageSizeMb,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// ── Export Request: Confirm (draft → queued) ────────────────────────────

adminExports.put('/export-requests/:id/confirm', async (c) => {
  const id = c.req.param('id')

  try {
    const { data: job, error: fetchErr } = await supabaseAdmin
      .from('export_jobs')
      .select('status')
      .eq('id', id)
      .single()

    if (fetchErr || !job) {
      return c.json({ error: 'Export job not found' }, 404)
    }
    if (job.status !== 'draft') {
      return c.json({ error: `Cannot confirm: current status is '${job.status}', expected 'draft'` }, 400)
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('export_jobs')
      .update({
        status: 'queued',
        started_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (updateErr) {
      return c.json({ error: updateErr.message }, 500)
    }

    return c.json({ data: updated })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// ── Export Request: Process (queued → processing → reviewing) ───────────

adminExports.post('/export-requests/:id/process', async (c) => {
  const id = c.req.param('id')

  try {
    // 1. Validate status
    const { data: job, error: fetchErr } = await supabaseAdmin
      .from('export_jobs')
      .select('*')
      .eq('id', id)
      .single()

    if (fetchErr || !job) {
      return c.json({ error: 'Export job not found' }, 404)
    }
    if (job.status !== 'queued') {
      return c.json({ error: `Cannot process: current status is '${job.status}', expected 'queued'` }, 400)
    }

    // 2. Update status → processing
    await supabaseAdmin
      .from('export_jobs')
      .update({ status: 'processing' })
      .eq('id', id)

    const filters = (job.filters ?? {}) as Record<string, unknown>

    // 3. Pool and rank BUs
    const poolFilters = {
      qualityGrades: (filters.qualityGrades as string[]) ?? undefined,
      dateFrom: (filters.dateFrom as string) ?? undefined,
      dateTo: (filters.dateTo as string) ?? undefined,
      requireConsent: true,
      requirePiiCleaned: true,
      minQaScore: 50,
      requireTranscript: true,
    }
    const diversityConstraints = (filters.diversityConstraints as Record<string, unknown>) ?? {}

    console.log('[process] poolFilters:', JSON.stringify(poolFilters))
    console.log('[process] diversityConstraints:', JSON.stringify(diversityConstraints))

    const poolResult = await poolAndRankBUs(
      job.sku_id,
      job.requested_units,
      poolFilters,
      {},
      diversityConstraints,
    )
    console.log('[process] poolResult:', {
      selectedBUs: poolResult.selectedBUs.length,
      canFulfill: poolResult.canFulfill,
      available: poolResult.available,
      shortfall: poolResult.shortfall,
      summary: poolResult.summary,
    })

    // 4. Lock selected BUs
    if (poolResult.selectedBUs.length > 0) {
      const buIds = poolResult.selectedBUs.map((bu) => bu.id)
      const BATCH = 500
      for (let i = 0; i < buIds.length; i += BATCH) {
        const batch = buIds.slice(i, i + BATCH)
        await supabaseAdmin
          .from('billable_units')
          .update({ lock_status: 'locked_for_job', locked_by_job_id: id })
          .in('id', batch)
          .eq('lock_status', 'available')
      }
    }

    // 5. Update actual_units
    await supabaseAdmin
      .from('export_jobs')
      .update({ actual_units: poolResult.selectedBUs.length })
      .eq('id', id)

    // 6. Segment utterances for selected sessions
    const sessionMap = new Map<string, string>()
    for (const bu of poolResult.selectedBUs) {
      if (!sessionMap.has(bu.sessionId) && bu.userId) {
        sessionMap.set(bu.sessionId, bu.userId)
      }
    }

    const sessionsToSegment = [...sessionMap.entries()].map(([sessionId, userId]) => ({
      sessionId,
      audioStoragePath: `${userId}/${sessionId}/${sessionId}.wav`,
    }))

    const segResults = await segmentBulk(sessionsToSegment)

    // 7. Save utterances to export_package_items
    const utteranceSaves = segResults.flatMap((sr) => {
      if (!sr.result) return []
      return sr.result.segments.map((seg) => ({
        utteranceId: seg.utteranceId,
        sessionId: sr.sessionId,
        buId: null,
        userId: sessionMap.get(sr.sessionId) ?? null,
        filePathInPackage: `audio/${seg.utteranceId}.wav`,
        fileSizeBytes: seg.fileSizeBytes,
        durationSec: seg.durationSec,
      }))
    })

    if (utteranceSaves.length > 0) {
      await saveUtterances(id, utteranceSaves)
    }

    // 8. Quality analysis for selected sessions
    const sessionsForQuality = [...sessionMap.entries()].map(([sessionId, userId]) => ({
      sessionId,
      userId,
    }))
    await analyzeBulk(sessionsForQuality)

    // 9. Update utterance_count + status → reviewing
    await supabaseAdmin
      .from('export_jobs')
      .update({
        status: 'reviewing',
        utterance_count: utteranceSaves.length,
      })
      .eq('id', id)

    return c.json({
      data: {
        status: 'reviewing',
        selectedBUs: poolResult.selectedBUs.length,
        canFulfill: poolResult.canFulfill,
        shortfall: poolResult.shortfall,
        utteranceCount: utteranceSaves.length,
        segmentationErrors: segResults.filter((r) => r.error).length,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // Mark job as failed
    await supabaseAdmin
      .from('export_jobs')
      .update({ status: 'failed', error_message: message })
      .eq('id', id)
    return c.json({ error: message }, 500)
  }
})

// ── Export Request: List Utterances ──────────────────────────────────────

adminExports.get('/export-requests/:id/utterances', async (c) => {
  const id = c.req.param('id')

  try {
    const utterances = await getUtterancesByExportRequest(id)

    // Add signed URLs for playback
    const withUrls = await Promise.all(
      utterances.map(async (u) => {
        let signedUrl: string | null = null
        if (u.utterance_id && u.session_id) {
          try {
            const s3Key = `utterances/${u.session_id}/${u.utterance_id}.wav`
            signedUrl = await getSignedUrl('sanitized-audio', s3Key, 600)
          } catch {
            // ignore — URL generation may fail for missing files
          }
        }
        return { ...u, signedUrl }
      }),
    )

    return c.json({ data: withUrls })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// ── Export Request: Review Utterances ────────────────────────────────────

adminExports.put('/export-requests/:id/utterances/review', async (c) => {
  const id = c.req.param('id')
  const { updates } = getBody<{
    updates: Array<{
      utteranceId: string
      isIncluded: boolean
      excludeReason?: string
    }>
  }>(c)

  if (!Array.isArray(updates) || updates.length === 0) {
    return c.json({ error: 'updates array is required' }, 400)
  }

  try {
    // Verify the export job exists
    const { data: job, error: jobErr } = await supabaseAdmin
      .from('export_jobs')
      .select('id')
      .eq('id', id)
      .single()

    if (jobErr || !job) {
      return c.json({ error: 'Export job not found' }, 404)
    }

    let updated = 0
    for (const { utteranceId, isIncluded, excludeReason } of updates) {
      try {
        await updateUtteranceStatus(utteranceId, isIncluded, excludeReason)
        updated++
      } catch {
        // skip individual failures
      }
    }

    return c.json({ data: { updated, total: updates.length } })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// ── Export Request: Finalize (packaging) ────────────────────────────────

/**
 * POST /admin/export-requests/:id/finalize
 * reviewing → packaging → buildPackage → ready
 * 에러 시 status → failed
 */
adminExports.post('/export-requests/:id/finalize', async (c) => {
  const id = c.req.param('id')

  try {
    // 현재 상태 확인
    const { data: job, error: fetchError } = await supabaseAdmin
      .from('export_jobs')
      .select('status')
      .eq('id', id)
      .single()

    if (fetchError || !job) {
      return c.json({ error: 'Export job not found' }, 404)
    }

    if (job.status !== 'reviewing') {
      return c.json({ error: `Cannot finalize: current status is '${job.status}', expected 'reviewing'` }, 400)
    }

    // status → packaging
    const { error: updateError } = await supabaseAdmin
      .from('export_jobs')
      .update({ status: 'packaging' })
      .eq('id', id)

    if (updateError) {
      return c.json({ error: updateError.message }, 500)
    }

    // buildPackage (내부에서 status → ready 전환)
    const result = await buildPackage(id)

    return c.json({
      data: {
        storagePath: result.storagePath,
        sizeBytes: result.sizeBytes,
        utteranceCount: result.utteranceCount,
      },
    })
  } catch (err: any) {
    // 실패 시 status → failed
    console.error(`Finalize failed for ${id}:`, err.message)
    await supabaseAdmin
      .from('export_jobs')
      .update({ status: 'failed' })
      .eq('id', id)

    return c.json({ error: err.message }, 500)
  }
})

// ── Export Request: Download ────────────────────────────────────────────

/**
 * GET /admin/export-requests/:id/download
 * status가 'ready'인 경우에만 서명 URL 반환
 */
adminExports.get('/export-requests/:id/download', async (c) => {
  const id = c.req.param('id')

  try {
    // 상태 확인
    const { data: job, error: fetchError } = await supabaseAdmin
      .from('export_jobs')
      .select('status')
      .eq('id', id)
      .single()

    if (fetchError || !job) {
      return c.json({ error: 'Export job not found' }, 404)
    }

    if (job.status !== 'ready') {
      return c.json({ error: `Package not ready: current status is '${job.status}'` }, 400)
    }

    const { downloadUrl, expiresAt } = await getSignedDownloadUrl(id)

    return c.json({ data: { downloadUrl, expiresAt } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default adminExports
