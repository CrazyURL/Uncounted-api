// ── Admin Export v2 Routes (창 D) ─────────────────────────────────────
//
// SPEC_EXPORT_V2.md §6.1 ~ §6.3.
// D2 결정 (2026-05-19): SPEC §6 의 /api/admin/export-jobs/:id 가 레거시 admin-exports.ts (plural) 와
// 경로 충돌하므로, v2 라우트는 별도 prefix `/api/admin/export/*` 사용.
//
// 본 창 산출:
//   - POST /export/sessions/:id    Layer 2 단건 — 풀구현 (buildSessionExportZip 호출)
//   - POST /export/sessions/batch  Layer 3 배치 — 501 (buildBatchExportZip placeholder)
//   - GET  /export/jobs/:id        상태 조회   — 501 (export_jobs_v2 테이블 부재)

import { Hono } from 'hono'
import { promises as fs } from 'node:fs'

import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import { getSignedUrl, S3_AUDIO_BUCKET, uploadObject } from '../lib/s3.js'
import { buildSessionExportZip } from '../services/export/export-builder.js'

const adminExport = new Hono()

adminExport.use('/*', authMiddleware)
adminExport.use('/*', adminMiddleware)

interface ExportLayer2Body {
  include_audio?: boolean
  include_restricted?: boolean
}

// ── 6.1 Layer 2 단건 export ───────────────────────────────────────────
adminExport.post('/export/sessions/:id', async (c) => {
  const sessionId = c.req.param('id')
  const body = getBody<ExportLayer2Body>(c)
  const includeRestricted = body.include_restricted === true // 안전선 #10

  // 창 C embedded WAV 미구현 → API 단에서 강제 차단 (수정 지시 1).
  // buildSessionExportZip 도 includeAudio+embedded 조합을 throw 하지만
  // SPEC 의 audio_export_mode 디폴트가 reference_only 이므로 API 단에서 명시 차단이 더 명확하다.
  if (body.include_audio === true) {
    return c.json(
      {
        success: false,
        error: 'embedded audio export is not implemented yet. Use include_audio=false.',
      },
      400,
    )
  }

  try {
    const result = await buildSessionExportZip({
      sessionId,
      includeAudio: false, // 강제 false (수정 지시 1)
      audioExportMode: 'reference_only', // 안전선 #8
      includeRestricted,
    })

    // 수정 지시 2 — export ZIP S3 bucket.
    // TODO: move export ZIPs to S3_EXPORT_BUCKET when configured.
    // Temporarily stores under exports/v2/single/* prefix in S3_AUDIO_BUCKET.
    const exportBucket = process.env.S3_EXPORT_BUCKET ?? S3_AUDIO_BUCKET
    const key = `exports/v2/single/${sessionId}_${Date.now()}.zip`

    // iwinv 오브젝트 스토리지는 streaming(aws-chunked) 업로드를 411 MissingContentLength 로
    // 거부한다 → 파일을 Buffer 로 읽어 고정 Content-Length 로 업로드(embedded worker 와 동일 패턴).
    const zipBuffer = await fs.readFile(result.zipPath)
    await uploadObject(exportBucket, key, zipBuffer, 'application/zip')

    const downloadUrl = await getSignedUrl(
      exportBucket,
      key,
      60 * 60 * 24,
      `session_export_${sessionId}.zip`,
    )
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

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
    // embedded mode 차단 메시지 (API 단에서 막아야 하지만 builder 측 안전망)
    if (msg.includes('audioExportMode=embedded')) {
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

// ── 6.2 Layer 3 배치 export — 차단 사유 명시 ──────────────────────────
adminExport.post('/export/sessions/batch', (c) => {
  return c.json(
    {
      success: false,
      error:
        'Layer 3 batch export not available: buildBatchExportZip() is a placeholder in ' +
        'services/export/export-builder.ts. Window C must implement before this endpoint ' +
        'is enabled. See WORKSTREAM_DEPENDENCIES.md §3.3.',
    },
    501,
  )
})

// ── 6.3 Job 상태 조회 — export_jobs_v2 테이블 부재 ────────────────────
adminExport.get('/export/jobs/:id', (c) => {
  return c.json(
    {
      success: false,
      error:
        'export_jobs_v2 table missing: requires Window A follow-up migration. ' +
        'Current migrations 070~074 do not create export_jobs_v2.',
    },
    501,
  )
})

export default adminExport
