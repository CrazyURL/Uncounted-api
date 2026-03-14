// ── 청크별 트랜스크립트 + 오디오 통계 저장 라우트 ──────────────────────────
// POST /api/transcript-chunks
// session_chunks(오디오 파일 업로드)와 분리 — 텍스트 + 품질 지표 전용.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'

const transcriptChunks = new Hono()

transcriptChunks.use('/*', authMiddleware)

transcriptChunks.post('/', async (c) => {
  const userId = c.get('userId') as string
  const {
    sessionId,
    chunkIndex,
    transcriptText,
    startSec,
    endSec,
    durationSec,
    audioStats,
    words,
  } = getBody<{
    sessionId: string
    chunkIndex: number
    transcriptText: string
    startSec: number
    endSec: number
    durationSec: number
    audioStats: {
      rms: number
      silenceRatio: number
      clippingRatio: number
      snrDb: number
    } | undefined
    words: unknown[] | undefined
  }>(c)

  if (!sessionId || chunkIndex == null || startSec == null || endSec == null || durationSec == null) {
    return c.json({ error: 'Missing required fields' }, 400)
  }

  const { error } = await supabaseAdmin
    .from('transcript_chunks')
    .upsert(
      {
        session_id:      sessionId,
        user_id:         userId,
        chunk_index:     chunkIndex,
        transcript_text: transcriptText ?? null,
        start_sec:       startSec,
        end_sec:         endSec,
        duration_sec:    durationSec,
        audio_stats:     audioStats ?? null,
        words:           words ?? null,
        updated_at:      new Date().toISOString(),
      },
      { onConflict: 'session_id,chunk_index' },
    )

  if (error) {
    console.error('[transcriptChunks] upsert error:', error.message)
    return c.json({ error: error.message }, 500)
  }

  return c.json({ ok: true })
})

export default transcriptChunks
