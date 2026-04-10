// ── Admin Metadata API Routes ─────────────────────────────────────────
// 메타데이터 이벤트 관리 전용 라우트 (admin-metadata)
// 기존 admin.ts의 metadata 엔드포인트를 분리

import { Hono } from 'hono'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import { supabaseAdmin } from '../lib/supabase.js'
import { getSignedUrl, S3_META_BUCKET } from '../lib/s3.js'
import {
  getMetadataStats,
  getMetadataEvents,
  getMetadataSummary,
  getMetadataInventory,
  getMetadataSkuStats,
  getMetadataPreview,
  type QualityGrade,
} from '../lib/export/metadataRepository.js'
import { buildMetadataPackage } from '../lib/export/metadataPackageBuilder.js'

const metadataAdmin = new Hono()

// 모든 라우트에 인증 + 관리자 권한 필수
metadataAdmin.use('/*', authMiddleware)
metadataAdmin.use('/*', adminMiddleware)

// ── Stats ─────────────────────────────────────────────────────────────

/**
 * GET /admin/metadata/stats
 * 스키마별 메타데이터 이벤트 카운트
 */
metadataAdmin.get('/stats', async (c) => {
  try {
    const stats = await getMetadataStats()
    return c.json({ data: stats })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: message }, 500)
  }
})

// ── Summary ───────────────────────────────────────────────────────────

/**
 * GET /admin/metadata/summary
 * 메타 탭 대시보드용 요약 (전체 이벤트 수, 유저 수, 스키마별 카운트)
 */
metadataAdmin.get('/summary', async (c) => {
  try {
    const summary = await getMetadataSummary()
    return c.json({ data: summary })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: message }, 500)
  }
})

// ── Events ────────────────────────────────────────────────────────────

/**
 * GET /admin/metadata/events?schema=U-M07-v1&pseudo_id=xxx&limit=100&offset=0
 * 메타데이터 이벤트 조회 (페이지네이션)
 */
metadataAdmin.get('/events', async (c) => {
  try {
    const result = await getMetadataEvents({
      schemaId: c.req.query('schema') ?? undefined,
      pseudoId: c.req.query('pseudo_id') ?? undefined,
      limit: Number(c.req.query('limit') ?? 100),
      offset: Number(c.req.query('offset') ?? 0),
    })
    return c.json({ data: result.data, total: result.total })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: message }, 500)
  }
})

// ── SKU Stats ─────────────────────────────────────────────────────────

/**
 * GET /admin/metadata/:schemaId/stats
 * SKU 상세 통계 — 디바이스 목록, 필드 분포, 히트맵
 */
metadataAdmin.get('/:schemaId/stats', async (c) => {
  try {
    const schemaId = c.req.param('schemaId')
    const stats = await getMetadataSkuStats(schemaId)
    return c.json({ data: stats })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: message }, 500)
  }
})

// ── Inventory ─────────────────────────────────────────────────────────

/**
 * GET /admin/metadata/inventory
 * SKU 재고 현황 — 스키마별 이벤트 수, 디바이스 수, 기간, 품질 분포, 동기화 상태
 */
metadataAdmin.get('/inventory', async (c) => {
  try {
    const inventory = await getMetadataInventory()
    return c.json({ data: inventory })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: message }, 500)
  }
})

// ── Preview ───────────────────────────────────────────────────────────

const VALID_QUALITY_GRADES = new Set(['good', 'partial', 'sparse'])

/**
 * GET /admin/metadata/:schemaId/preview?quality=good&dateFrom=2026-01&dateTo=2026-03&pseudoId=xxx&limit=50&offset=0
 * 이벤트 프리뷰 — 필터링 + 필드 분포
 */
metadataAdmin.get('/:schemaId/preview', async (c) => {
  try {
    const schemaId = c.req.param('schemaId')
    const qualityParam = c.req.query('quality')
    const quality = qualityParam && VALID_QUALITY_GRADES.has(qualityParam)
      ? (qualityParam as QualityGrade)
      : undefined

    const result = await getMetadataPreview(schemaId, {
      quality,
      dateFrom: c.req.query('dateFrom') ?? undefined,
      dateTo: c.req.query('dateTo') ?? undefined,
      pseudoId: c.req.query('pseudoId') ?? undefined,
      limit: Number(c.req.query('limit') ?? 50),
      offset: Number(c.req.query('offset') ?? 0),
    })
    return c.json({ data: result })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: message }, 500)
  }
})

// ── Export: Create ────────────────────────────────────────────────────

interface MetadataExportBody {
  schemaIds: string[]
  clientName: string
  filters?: {
    pseudoIds?: string[]
    dateFrom?: string
    dateTo?: string
    quality?: QualityGrade
    excludeQuality?: QualityGrade
    excludeStaleDevices?: boolean
  }
}

const DOWNLOAD_EXPIRES_SEC = 24 * 60 * 60 // 24h

/**
 * POST /admin/metadata/export
 * 메타데이터 export 작업 생성 → 패키지 빌드 → S3 업로드
 */
metadataAdmin.post('/export', async (c) => {
  const body = getBody<MetadataExportBody>(c)

  if (!Array.isArray(body.schemaIds) || body.schemaIds.length === 0) {
    return c.json({ error: 'schemaIds[] is required' }, 400)
  }
  if (!body.clientName) {
    return c.json({ error: 'clientName is required' }, 400)
  }

  const jobId = crypto.randomUUID()

  try {
    // 1. Create export_jobs record (status: processing)
    const { error: insertError } = await supabaseAdmin
      .from('export_jobs')
      .insert({
        id: jobId,
        type: 'metadata',
        sku_id: body.schemaIds.length === 1 ? body.schemaIds[0] : 'U-M_BUNDLE',
        client_name: body.clientName,
        requested_units: 0,
        filters: {
          schemaIds: body.schemaIds,
          ...body.filters,
        },
        status: 'processing',
        started_at: new Date().toISOString(),
      })

    if (insertError) {
      return c.json({ error: insertError.message }, 500)
    }

    // 2. Build ZIP package and upload to S3
    const result = await buildMetadataPackage(jobId, {
      schemaIds: body.schemaIds,
      clientName: body.clientName,
      filters: body.filters,
    })

    // 3. Update job → ready
    await supabaseAdmin
      .from('export_jobs')
      .update({
        status: 'ready',
        actual_units: result.totalEvents,
        package_storage_path: result.storagePath,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId)

    return c.json({
      data: {
        jobId,
        status: 'ready',
        storagePath: result.storagePath,
        sizeBytes: result.sizeBytes,
        totalEvents: result.totalEvents,
        schemaIds: result.schemaIds,
      },
    })
  } catch (err: unknown) {
    // Mark job as failed
    await supabaseAdmin
      .from('export_jobs')
      .update({ status: 'failed', error_message: err instanceof Error ? err.message : 'Unknown error' })
      .eq('id', jobId)

    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: message }, 500)
  }
})

// ── Export: Status ────────────────────────────────────────────────────

/**
 * GET /admin/metadata/export/:jobId/status
 * export 작업 상태 조회
 */
metadataAdmin.get('/export/:jobId/status', async (c) => {
  try {
    const jobId = c.req.param('jobId')

    const { data: job, error } = await supabaseAdmin
      .from('export_jobs')
      .select('id, type, sku_id, client_name, status, actual_units, filters, package_storage_path, error_message, created_at, started_at, completed_at')
      .eq('id', jobId)
      .eq('type', 'metadata')
      .single()

    if (error || !job) {
      return c.json({ error: 'Metadata export job not found' }, 404)
    }

    return c.json({ data: job })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: message }, 500)
  }
})

// ── Export: Download ─────────────────────────────────────────────────

/**
 * GET /admin/metadata/export/:jobId/download
 * 서명 URL 발급 (24시간 유효, S3_META_BUCKET)
 */
metadataAdmin.get('/export/:jobId/download', async (c) => {
  try {
    const jobId = c.req.param('jobId')

    const { data: job, error: fetchError } = await supabaseAdmin
      .from('export_jobs')
      .select('status, package_storage_path')
      .eq('id', jobId)
      .eq('type', 'metadata')
      .single()

    if (fetchError || !job) {
      return c.json({ error: 'Metadata export job not found' }, 404)
    }

    if (job.status !== 'ready') {
      return c.json({ error: `Package not ready: current status is '${job.status}'` }, 400)
    }

    if (!job.package_storage_path) {
      return c.json({ error: 'No package available for this job' }, 400)
    }

    const downloadUrl = await getSignedUrl(S3_META_BUCKET, job.package_storage_path, DOWNLOAD_EXPIRES_SEC)
    const expiresAt = new Date(Date.now() + DOWNLOAD_EXPIRES_SEC * 1000).toISOString()

    // Update download info
    await supabaseAdmin
      .from('export_jobs')
      .update({
        download_url: downloadUrl,
        download_expires_at: expiresAt,
      })
      .eq('id', jobId)

    return c.json({ data: { downloadUrl, expiresAt } })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: message }, 500)
  }
})

export default metadataAdmin
