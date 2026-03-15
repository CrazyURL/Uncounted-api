// ── Session Chunks 라우트 ───────────────────────────────────────────────────
// 청크 단위 labels 업데이트 API
// uploadAudioChunk / saveTranscriptChunk와 동일한 per-chunk 호출 패턴

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'

const sessionChunks = new Hono()
sessionChunks.use('/*', authMiddleware)

// PUT /api/session-chunks/:sessionId/:chunkIndex/labels
// 청크 1개의 labels 업데이트
sessionChunks.put('/:sessionId/:chunkIndex/labels', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('sessionId')
  const chunkIndex = Number(c.req.param('chunkIndex'))
  const { labels } = getBody<{ labels: unknown }>(c)

  if (!labels || isNaN(chunkIndex)) {
    return c.json({ error: 'Missing labels or invalid chunkIndex' }, 400)
  }

  const { error } = await supabaseAdmin
    .from('session_chunks')
    .update({ labels, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .eq('chunk_index', chunkIndex)

  if (error) {
    console.error(`[sessionChunks] labels update error chunk=${chunkIndex}:`, error.message)
    return c.json({ error: error.message }, 500)
  }

  return c.json({ ok: true })
})

export default sessionChunks
