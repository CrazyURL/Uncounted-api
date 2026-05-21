// ── Admin Export v2 Routes (창 D / Phase 2B) ──────────────────────────
//
// SPEC_EXPORT_V2.md §6.1 ~ §6.3.
// D2 결정 (2026-05-19): SPEC §6 의 /api/admin/export-jobs/:id 가 레거시 admin-exports.ts (plural) 와
// 경로 충돌하므로, v2 라우트는 별도 prefix `/api/admin/export/*` 사용.
//
// 라우트:
//   - POST /export/sessions/:id    Layer 2 단건
//       · reference_only → 동기 처리 (ZIP S3 업로드 후 signed URL 반환)
//       · embedded       → export_embedded_jobs_v2 job 생성 + 202 (백그라운드 워커)
//   - POST /export/sessions/batch  Layer 3 배치 — 501 (Phase 3)
//   - GET  /export/jobs/:id        embedded job 상태 조회 (ready 시 signed URL 동적 발급)

import { Hono } from 'hono'
import { promises as fs } from 'node:fs'

import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import { getSignedUrl, S3_AUDIO_BUCKET, uploadObject } from '../lib/s3.js'
import { supabaseAdmin } from '../lib/supabase.js'
import { isExportEligible } from '../lib/export/eligibility.js'
import { buildSessionExportZip } from '../services/export/export-builder.js'
import { runEmbeddedExportJob } from '../services/export/embedded-export-worker.js'

const adminExport = new Hono()

adminExport.use('/*', authMiddleware)
adminExport.use('/*', adminMiddleware)

const EXPORT_BUCKET = process.env.S3_EXPORT_BUCKET ?? S3_AUDIO_BUCKET
const DOWNLOAD_TTL_SEC = 60 * 60 * 24 // 24h

// Phase 2B: 외부 계약은 audio_export_mode 만. include_audio 는 받지 않음(있어도 무시).
interface ExportLayer2Body {
  audio_export_mode?: 'reference_only' | 'embedded'
  include_restricted?: boolean
}

// ── 6.1 Layer 2 단건 export ───────────────────────────────────────────
adminExport.post('/export/sessions/:id', async (c) => {
  const sessionId = c.req.param('id')
  const body = getBody<ExportLayer2Body>(c)
  const mode = body.audio_export_mode === 'embedded' ? 'embedded' : 'reference_only'

  // ── embedded → 비동기 job (Phase 2B) ──────────────────────────────
  if (mode === 'embedded') {
    // 보정 #1: embedded 는 include_restricted 강제 false (restricted+실음성은 Phase 3).
    // 보정 #2(1차): job 생성 전 eligibility 사전 체크로 빠른 실패.
    const { data: session, error: sessErr } = await supabaseAdmin
      .from('sessions')
      .select('consent_status, review_status, session_dataset_eligible')
      .eq('id', sessionId)
      .maybeSingle()

    if (sessErr) {
      console.error('[admin-export] session lookup failed', { sessionId, sessErr })
      return c.json({ success: false, error: 'session lookup failed' }, 500)
    }
    if (!session) {
      return c.json({ success: false, error: 'session not found' }, 404)
    }
    const eligibility = isExportEligible(session)
    if (!eligibility.eligible) {
      return c.json(
        { success: false, error: `not export-eligible (${eligibility.reason})` },
        400,
      )
    }

    const { data: job, error: jobErr } = await supabaseAdmin
      .from('export_embedded_jobs_v2')
      .insert({
        status: 'queued',
        session_ids: [sessionId],
        audio_export_mode: 'embedded',
        include_restricted: false,
      })
      .select('id')
      .single()

    if (jobErr || !job) {
      console.error('[admin-export] job insert failed', { sessionId, jobErr })
      return c.json({ success: false, error: 'failed to create export job' }, 500)
    }

    // fire-and-forget 백그라운드 워커 (await 하지 않음)
    void runEmbeddedExportJob(job.id as string)

    return c.json({ success: true, data: { job_id: job.id, status: 'queued' } }, 202)
  }

  // ── reference_only → 동기 처리 (기존 경로) ────────────────────────
  const includeRestricted = body.include_restricted === true // 안전선 #10
  try {
    const result = await buildSessionExportZip({
      sessionId,
      audioExportMode: 'reference_only', // 안전선 #8
      includeRestricted,
    })

    const key = `exports/v2/single/${sessionId}_${Date.now()}.zip`

    // iwinv 오브젝트 스토리지는 streaming(aws-chunked) 업로드를 411 MissingContentLength 로
    // 거부한다 → 파일을 Buffer 로 읽어 고정 Content-Length 로 업로드(embedded worker 와 동일 패턴, #19).
    const zipBuffer = await fs.readFile(result.zipPath)
    await uploadObject(EXPORT_BUCKET, key, zipBuffer, 'application/zip')

    const downloadUrl = await getSignedUrl(
      EXPORT_BUCKET,
      key,
      DOWNLOAD_TTL_SEC,
      `session_export_${sessionId}.zip`,
    )
    const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_SEC * 1000).toISOString()

    // 로컬 staging ZIP 정리 (best-effort)
    await fs.unlink(result.zipPath).catch(() => {})

    return c.json({
      success: true,
      data: {
        download_url: downloadUrl,
        expires_at: expiresAt,
        size_bytes_estimate: zipBuffer.byteLength,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'

    // 안전선 #5 광의 차단 메시지 (export-builder 가 throw)
    if (msg.includes('not export-eligible')) {
      return c.json({ success: false, error: msg }, 400)
    }
    // SAFETY scan 위반 — 안전선 어딘가 위반
    if (msg.startsWith('Export safety violation')) {
      console.error('[admin-export] safety violation blocked', { sessionId, msg })
      return c.json({ success: false, error: 'safety violation detected, export blocked' }, 500)
    }

    console.error('[admin-export] Layer 2 build failed', { sessionId, err })
    return c.json({ success: false, error: msg }, 500)
  }
})

// ── 6.2 Layer 3 배치 export — 차단 사유 명시 (Phase 3) ─────────────────
adminExport.post('/export/sessions/batch', (c) => {
  return c.json(
    {
      success: false,
      error:
        'Layer 3 batch export not available: buildBatchExportZip() is a placeholder in ' +
        'services/export/export-builder.ts. Phase 3 must implement before this endpoint ' +
        'is enabled. See WORKSTREAM_DEPENDENCIES.md §3.3.',
    },
    501,
  )
})

// ── 6.3 embedded job 상태 조회 ────────────────────────────────────────
// ready 시 storage_path 로 signed download_url 을 동적 발급해 반환 (DB 미저장).
adminExport.get('/export/jobs/:id', async (c) => {
  const jobId = c.req.param('id')

  const { data: job, error } = await supabaseAdmin
    .from('export_embedded_jobs_v2')
    .select(
      'id, status, audio_export_mode, packaging_stage, storage_path, size_bytes, error_message, created_at, updated_at',
    )
    .eq('id', jobId)
    .maybeSingle()

  if (error) {
    console.error('[admin-export] job lookup failed', { jobId, error })
    return c.json({ success: false, error: 'job lookup failed' }, 500)
  }
  if (!job) {
    return c.json({ success: false, error: 'job not found' }, 404)
  }

  const data: Record<string, unknown> = {
    id: job.id,
    status: job.status,
    audio_export_mode: job.audio_export_mode,
    packaging_stage: job.packaging_stage ?? null,
    size_bytes: job.size_bytes ?? null,
    error_message: job.error_message ?? null,
  }

  if (job.status === 'ready' && typeof job.storage_path === 'string' && job.storage_path) {
    const sessionId = jobId // 파일명 표기용 (단건). 실제 키는 storage_path.
    data.download_url = await getSignedUrl(
      EXPORT_BUCKET,
      job.storage_path,
      DOWNLOAD_TTL_SEC,
      `session_export_${sessionId}.zip`,
    )
    data.expires_at = new Date(Date.now() + DOWNLOAD_TTL_SEC * 1000).toISOString()
  }

  return c.json({ success: true, data })
})

export default adminExport
