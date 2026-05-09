// ── Admin GPU Worker Monitoring ─────────────────────────────────────
// BM v10 STAGE 2.6 — GPU 워커 상태 모니터링 + 수동 재시도

import { Hono } from 'hono'
import { authMiddleware, adminMiddleware } from '../lib/middleware.js'
import { supabaseAdmin } from '../lib/supabase.js'
import { getWorkerStatus } from '../services/gpu-worker.js'

const adminGpuWorker = new Hono()

adminGpuWorker.use('/*', authMiddleware)
adminGpuWorker.use('/*', adminMiddleware)

/**
 * GET /api/admin/gpu-worker/status
 * 워커 큐 + 최근 실패 + 현재 처리 중 세션 한눈에
 */
adminGpuWorker.get('/gpu-worker/status', async (c) => {
  try {
    const status = await getWorkerStatus()
    return c.json({ data: status })
  } catch (err: any) {
    return c.json({ error: err.message ?? String(err) }, 500)
  }
})

/**
 * POST /api/admin/gpu-worker/retry/:sessionId
 * 영구 failed 된 세션을 admin 이 강제 재시도 (retry_count 리셋 후 pending 으로)
 */
adminGpuWorker.post('/gpu-worker/retry/:sessionId', async (c) => {
  const { sessionId } = c.req.param()
  if (!sessionId) return c.json({ error: 'Missing sessionId' }, 400)

  const { data: row, error: selectErr } = await supabaseAdmin
    .from('sessions')
    .select('id, gpu_upload_status, raw_audio_url, gpu_retry_count')
    .eq('id', sessionId)
    .single()

  if (selectErr || !row) {
    return c.json({ error: 'Session not found' }, 404)
  }
  if (!row.raw_audio_url) {
    return c.json({ error: 'raw_audio_url 없음 — 재시도 불가' }, 400)
  }

  const { error: updateErr } = await supabaseAdmin
    .from('sessions')
    .update({
      gpu_upload_status: 'pending',
      gpu_retry_count: 0,
      gpu_last_error: null,
      gpu_started_at: null,
    })
    .eq('id', sessionId)

  if (updateErr) return c.json({ error: updateErr.message }, 500)

  return c.json({
    data: {
      sessionId,
      previousStatus: row.gpu_upload_status,
      previousRetryCount: row.gpu_retry_count,
      message: '재시도 큐 진입 — 30초 내 워커가 픽업합니다',
    },
  })
})

export default adminGpuWorker
