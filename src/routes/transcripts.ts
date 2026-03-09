// ── Transcripts API Routes ─────────────────────────────────────────────
// STT 전사 데이터 관리 API

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'
import { encryptId } from '../lib/crypto.js'

const transcripts = new Hono()

// 모든 라우트에 인증 필수
transcripts.use('/*', authMiddleware)

// ── 타입 정의 ──────────────────────────────────────────────────────────

type TranscriptWord = {
  word: string
  start: number
  end: number
  probability: number
}

// ── API 엔드포인트 ──────────────────────────────────────────────────────

/**
 * POST /transcripts/:sessionId
 * 전사 데이터 저장/업데이트
 */
transcripts.post('/:sessionId', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('sessionId')
  const { text, summary, words, source } = getBody<{ text: string; summary?: string; words?: unknown[]; source?: string }>(c)

  if (!text || typeof text !== 'string') {
    return c.json({ error: 'Text is required' }, 400)
  }

  try {
    const row: Record<string, unknown> = {
      session_id: sessionId,
      user_id: userId,
      text,
      created_at: new Date().toISOString(),
    }

    if (summary) row.summary = summary
    if (words && Array.isArray(words)) row.words = words
    if (source) row.source = source

    const { data, error } = await supabaseAdmin
      .from('transcripts')
      .upsert(row, { onConflict: 'session_id' })
      .select()
      .single()

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({
      data: {
        sessionId: encryptId(sessionId),
        text: encryptId(data.text),
        summary: data.summary ? encryptId(data.summary) : undefined,
        words: data.words ?? undefined,
        createdAt: data.created_at,
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /transcripts/:sessionId
 * 전사 데이터 조회 (전체 정보)
 */
transcripts.get('/:sessionId', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('sessionId')

  try {
    const { data, error } = await supabaseAdmin
      .from('transcripts')
      .select('*')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ data: null })
      }
      return c.json({ error: error.message }, 500)
    }

    return c.json({
      data: {
        text: encryptId(data.text),
        summary: data.summary ? encryptId(data.summary) : undefined,
        words: data.words ?? undefined,
        createdAt: data.created_at,
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /transcripts
 * 모든 전사 데이터 조회 (사용자 세션 전체)
 */
transcripts.get('/', async (c) => {
  const userId = c.get('userId') as string

  try {
    const { data, error } = await supabaseAdmin
      .from('transcripts')
      .select('session_id, text, summary, created_at, words')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    const transcripts = (data ?? []).map((row) => ({
      sessionId: encryptId(row.session_id),
      text: encryptId(row.text),
      summary: row.summary ? encryptId(row.summary) : undefined,
      words: row.words ?? undefined,
      createdAt: row.created_at,
    }))

    return c.json({ data: transcripts })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * DELETE /transcripts/:sessionId
 * 전사 데이터 삭제
 */
transcripts.delete('/:sessionId', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('sessionId')

  try {
    const { error } = await supabaseAdmin
      .from('transcripts')
      .delete()
      .eq('session_id', sessionId)
      .eq('user_id', userId)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default transcripts
