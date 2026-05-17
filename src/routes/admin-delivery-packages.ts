// ── Admin Delivery Packages & 3-Layer Export Routes ─────────────────────
// Layer 1: delivery_packages 기반 납품 패키지 관리
// Layer 2: 단일 세션 즉시 export (signed URL 반환)
// Layer 3: 배치 세션 비동기 export (export_jobs_v2 polling)
// Internal: Cron 트리거 엔드포인트

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import { encryptId } from '../lib/crypto.js'
import { getSignedUrl, S3_AUDIO_BUCKET, EXPORTS_PREFIX } from '../lib/s3.js'
import type { DeliveryPackage, ExportJobV2 } from '../types/delivery.js'

const adminDeliveryPackages = new Hono()

// ── 내부 Cron 인증 (Internal-Secret 헤더) ──────────────────────────────

const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? ''

function isInternalRequest(c: { req: { header: (h: string) => string | undefined } }): boolean {
  if (!INTERNAL_SECRET) return false
  return c.req.header('x-internal-secret') === INTERNAL_SECRET
}

// ── Admin 인증 적용 (internal/* 제외) ──────────────────────────────────

adminDeliveryPackages.use('/delivery/*', authMiddleware)
adminDeliveryPackages.use('/delivery/*', adminMiddleware)
adminDeliveryPackages.use('/sessions/:id/export', authMiddleware)
adminDeliveryPackages.use('/sessions/:id/export', adminMiddleware)
adminDeliveryPackages.use('/sessions/export-batch', authMiddleware)
adminDeliveryPackages.use('/sessions/export-batch', adminMiddleware)
adminDeliveryPackages.use('/export-jobs-v2/*', authMiddleware)
adminDeliveryPackages.use('/export-jobs-v2/*', adminMiddleware)

// ── Helpers ────────────────────────────────────────────────────────────

function packageFromRow(row: Record<string, unknown>): DeliveryPackage {
  return {
    id: row.id as string,
    package_number: row.package_number as string,
    filename: row.filename as string,
    storage_path: row.storage_path as string,
    status: row.status as DeliveryPackage['status'],
    duration_seconds: Number(row.duration_seconds ?? 0),
    duration_minutes: Number(row.duration_minutes ?? 0),
    billable_hours: Number(row.billable_hours ?? 0),
    session_count: Number(row.session_count ?? 0),
    utterance_count: Number(row.utterance_count ?? 0),
    size_bytes: row.size_bytes != null ? Number(row.size_bytes) : null,
    created_at: row.created_at as string,
    completed_at: (row.completed_at as string | null) ?? null,
    delivered_at: (row.delivered_at as string | null) ?? null,
    delivered_to_client_id: (row.delivered_to_client_id as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  }
}

function jobFromRow(row: Record<string, unknown>): ExportJobV2 {
  return {
    id: row.id as string,
    type: row.type as ExportJobV2['type'],
    status: row.status as ExportJobV2['status'],
    session_ids: (row.session_ids as string[] | null) ?? null,
    package_id: (row.package_id as string | null) ?? null,
    storage_path: (row.storage_path as string | null) ?? null,
    user_id: (row.user_id as string | null) ?? null,
    progress: Number(row.progress ?? 0),
    total: row.total != null ? Number(row.total) : null,
    error_message: (row.error_message as string | null) ?? null,
    created_at: row.created_at as string,
    completed_at: (row.completed_at as string | null) ?? null,
    expires_at: (row.expires_at as string | null) ?? null,
  }
}

// ── Layer 1: Delivery Packages ─────────────────────────────────────────

/** GET /api/admin/delivery/packages — 납품 패키지 목록 (페이지네이션) */
adminDeliveryPackages.get('/delivery/packages', async (c) => {
  const status = c.req.query('status')
  const page = Math.max(1, Number(c.req.query('page') ?? '1'))
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? '20')))
  const offset = (page - 1) * limit

  try {
    let query = supabaseAdmin
      .from('delivery_packages')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (status) {
      query = query.eq('status', status)
    }

    const { data, error, count } = await query

    if (error) return c.json({ error: error.message }, 500)

    return c.json({
      data: (data ?? []).map(packageFromRow),
      meta: {
        total: count ?? 0,
        page,
        limit,
      },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: msg }, 500)
  }
})

/** GET /api/admin/delivery/packages/:id — 단일 납품 패키지 */
adminDeliveryPackages.get('/delivery/packages/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { data, error } = await supabaseAdmin
      .from('delivery_packages')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') return c.json({ error: 'Not Found' }, 404)
      return c.json({ error: error.message }, 500)
    }

    return c.json({ data: packageFromRow(data) })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: msg }, 500)
  }
})

/** GET /api/admin/delivery/packages/:id/download — Presigned URL 발급 */
adminDeliveryPackages.get('/delivery/packages/:id/download', async (c) => {
  const id = c.req.param('id')

  try {
    const { data, error } = await supabaseAdmin
      .from('delivery_packages')
      .select('id, status, storage_path, filename')
      .eq('id', id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') return c.json({ error: 'Not Found' }, 404)
      return c.json({ error: error.message }, 500)
    }

    if (data.status !== 'complete') {
      return c.json({ error: 'Package not ready', status: data.status }, 409)
    }

    if (!data.storage_path) {
      return c.json({ error: 'Storage path not set' }, 500)
    }

    // 다운로드 감사 로그 기록
    const userId = (c as unknown as { get: (key: string) => string }).get('userId') as string | undefined
    await supabaseAdmin.from('export_logs').insert({
      type: 'layer1_package',
      user_id: userId ?? null,
      package_id: id,
      storage_path: data.storage_path,
      downloaded_at: new Date().toISOString(),
      ip_address: c.req.header('x-forwarded-for') ?? null,
      user_agent: c.req.header('user-agent') ?? null,
    })

    const signedUrl = await getSignedUrl(
      S3_AUDIO_BUCKET,
      data.storage_path,
      3600,
      data.filename,
    )

    return c.json({ url: signedUrl, expiresIn: 3600 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: msg }, 500)
  }
})

// ── Layer 2: Single Session Export (Sync) ─────────────────────────────

/** POST /api/admin/sessions/:id/export — 단일 세션 즉시 ZIP export */
adminDeliveryPackages.post('/sessions/:id/export', async (c) => {
  const sessionId = c.req.param('id')

  try {
    // 세션 존재 여부 확인
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, stt_status, consent_status')
      .eq('id', sessionId)
      .single()

    if (sessionError) {
      if (sessionError.code === 'PGRST116') return c.json({ error: 'Session not found' }, 404)
      return c.json({ error: sessionError.message }, 500)
    }

    if (session.stt_status !== 'done') {
      return c.json({ error: 'Session STT not completed', stt_status: session.stt_status }, 409)
    }

    // export_jobs_v2에 즉시 처리 job 생성 후 background 실행
    const { data: job, error: jobError } = await supabaseAdmin
      .from('export_jobs_v2')
      .insert({
        type: 'single_session',
        status: 'queued',
        session_ids: [sessionId],
        progress: 0,
        total: 1,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single()

    if (jobError) return c.json({ error: jobError.message }, 500)

    // 다운로드 감사 로그
    const userId = (c as unknown as { get: (key: string) => string }).get('userId') as string | undefined
    void supabaseAdmin.from('export_logs').insert({
      type: 'layer2_single',
      user_id: userId ?? null,
      session_ids: [sessionId],
      downloaded_at: new Date().toISOString(),
      ip_address: c.req.header('x-forwarded-for') ?? null,
      user_agent: c.req.header('user-agent') ?? null,
    })

    return c.json({ jobId: job.id }, 202)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: msg }, 500)
  }
})

// ── Layer 3: Batch Session Export (Async) ─────────────────────────────

/** POST /api/admin/sessions/export-batch — 배치 세션 비동기 ZIP export */
adminDeliveryPackages.post('/sessions/export-batch', async (c) => {
  const body = getBody<{ session_ids: string[] }>(c)

  if (!body?.session_ids || !Array.isArray(body.session_ids) || body.session_ids.length === 0) {
    return c.json({ error: 'session_ids required (array)' }, 400)
  }

  const sessionIds = body.session_ids as string[]

  if (sessionIds.length > 500) {
    return c.json({ error: 'Maximum 500 sessions per batch' }, 400)
  }

  try {
    // 세션 STT 완료 여부 확인
    const { data: sessions, error: sessionsError } = await supabaseAdmin
      .from('sessions')
      .select('id, stt_status')
      .in('id', sessionIds)

    if (sessionsError) return c.json({ error: sessionsError.message }, 500)

    const notReady = (sessions ?? []).filter(s => s.stt_status !== 'done')
    if (notReady.length > 0) {
      return c.json({
        error: 'Some sessions not ready',
        not_ready_ids: notReady.map(s => s.id),
      }, 409)
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from('export_jobs_v2')
      .insert({
        type: 'batch_session',
        status: 'queued',
        session_ids: sessionIds,
        progress: 0,
        total: sessionIds.length,
        expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single()

    if (jobError) return c.json({ error: jobError.message }, 500)

    // 감사 로그
    const userId = (c as unknown as { get: (key: string) => string }).get('userId') as string | undefined
    void supabaseAdmin.from('export_logs').insert({
      type: 'layer3_batch',
      user_id: userId ?? null,
      session_ids: sessionIds,
      downloaded_at: new Date().toISOString(),
      ip_address: c.req.header('x-forwarded-for') ?? null,
      user_agent: c.req.header('user-agent') ?? null,
    })

    return c.json({ jobId: job.id }, 202)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: msg }, 500)
  }
})

// ── Export Job Polling ─────────────────────────────────────────────────

/** GET /api/admin/export-jobs-v2/:id — export job 상태 조회 */
adminDeliveryPackages.get('/export-jobs-v2/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { data, error } = await supabaseAdmin
      .from('export_jobs_v2')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') return c.json({ error: 'Not Found' }, 404)
      return c.json({ error: error.message }, 500)
    }

    const job = jobFromRow(data)

    // 완료된 경우 presigned download URL 함께 반환
    let downloadUrl: string | null = null
    if (job.status === 'complete' && job.storage_path) {
      try {
        downloadUrl = await getSignedUrl(S3_AUDIO_BUCKET, job.storage_path, 3600)
      } catch {
        // URL 생성 실패는 치명적이지 않음 — job 상태만 반환
      }
    }

    return c.json({ data: job, downloadUrl })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: msg }, 500)
  }
})

// ── Internal Cron Endpoints ────────────────────────────────────────────

/** POST /api/internal/packaging-batch — Layer 1 packaging worker 트리거 */
adminDeliveryPackages.post('/internal/packaging-batch', async (c) => {
  if (!isInternalRequest(c)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    // packaging-worker.ts의 runPackagingBatch()를 lazy import로 실행
    const { runPackagingBatch } = await import('../services/packaging-worker.js')
    void runPackagingBatch()
    return c.json({ ok: true, message: 'packaging batch triggered' })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[packaging-batch] trigger error:', msg)
    return c.json({ error: msg }, 500)
  }
})

/** POST /api/internal/process-export-jobs — queued export_jobs_v2 처리 */
adminDeliveryPackages.post('/internal/process-export-jobs', async (c) => {
  if (!isInternalRequest(c)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    // queued 상태의 export_jobs_v2 처리
    const { data: jobs, error } = await supabaseAdmin
      .from('export_jobs_v2')
      .select('id, type, session_ids, package_id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(5)

    if (error) return c.json({ error: error.message }, 500)
    if (!jobs || jobs.length === 0) return c.json({ ok: true, processed: 0 })

    // 각 job을 processing으로 마킹 후 background 실행
    for (const job of jobs) {
      await supabaseAdmin
        .from('export_jobs_v2')
        .update({ status: 'processing' })
        .eq('id', job.id)

      void processExportJobInBackground(job.id, job.type, job.session_ids as string[] | null)
    }

    return c.json({ ok: true, processed: jobs.length })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[process-export-jobs] error:', msg)
    return c.json({ error: msg }, 500)
  }
})

/** POST /api/internal/cleanup-expired-exports — 만료된 export 정리 */
adminDeliveryPackages.post('/internal/cleanup-expired-exports', async (c) => {
  if (!isInternalRequest(c)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    const now = new Date().toISOString()

    const { data: expired, error } = await supabaseAdmin
      .from('export_jobs_v2')
      .select('id, storage_path')
      .lt('expires_at', now)
      .in('status', ['complete', 'failed'])

    if (error) return c.json({ error: error.message }, 500)

    const expiredJobs = expired ?? []
    let deletedCount = 0

    for (const job of expiredJobs) {
      // S3 파일은 별도 정리 필요 (storage_path가 있는 경우)
      // 현재는 DB 레코드만 삭제
      await supabaseAdmin
        .from('export_jobs_v2')
        .delete()
        .eq('id', job.id)

      deletedCount++
    }

    return c.json({ ok: true, deleted: deletedCount })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[cleanup-expired-exports] error:', msg)
    return c.json({ error: msg }, 500)
  }
})

// ── Background Job Processor ───────────────────────────────────────────

async function processExportJobInBackground(
  jobId: string,
  type: string,
  sessionIds: string[] | null,
): Promise<void> {
  try {
    let storagePath: string | null = null
    const total = sessionIds?.length ?? 0

    if (type === 'single_session' && sessionIds?.length === 1) {
      const { buildSingleSessionZip } = await import('../services/export-builder.js')
      storagePath = await buildSingleSessionZip(sessionIds[0])
    } else if (type === 'batch_session' && sessionIds && sessionIds.length > 0) {
      const { buildBatchZip } = await import('../services/export-builder.js')
      storagePath = await buildBatchZip(sessionIds)
    }

    await supabaseAdmin
      .from('export_jobs_v2')
      .update({
        status: 'complete',
        storage_path: storagePath,
        progress: total,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[export-job] failed:', jobId, msg)

    await supabaseAdmin
      .from('export_jobs_v2')
      .update({
        status: 'failed',
        error_message: msg,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId)
  }
}

export default adminDeliveryPackages
