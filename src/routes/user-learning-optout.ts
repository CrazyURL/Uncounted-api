// ── User Learning Opt-out Route ────────────────────────────────────────
// AI 학습 데이터 활용 거부 (Opt-out) — 처리방침 v1.3 §13.1
//
// 거부 시 회사 자체 재학습 + 매수자 인도 양쪽에서 제외 (5영업일 SLA).
// users.learning_opt_out / learning_opt_out_at 토글.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'

const learningOptout = new Hono()

// GET /api/user/learning-optout — 현재 상태 조회
learningOptout.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId') as string

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('learning_opt_out, learning_opt_out_at')
    .eq('id', userId)
    .single()

  if (error) {
    console.error('[learning-optout] fetch failed:', error)
    return c.json({ error: 'fetch failed' }, 500)
  }

  return c.json({
    data: {
      learning_opt_out: data?.learning_opt_out ?? false,
      learning_opt_out_at: data?.learning_opt_out_at ?? null,
    },
  })
})

// PUT /api/user/learning-optout — 토글
learningOptout.put('/', authMiddleware, async (c) => {
  const userId = c.get('userId') as string
  const body = getBody<{ learning_opt_out?: boolean }>(c)

  if (typeof body.learning_opt_out !== 'boolean') {
    return c.json({ error: 'learning_opt_out (boolean) is required' }, 400)
  }

  const learningOptOut = body.learning_opt_out
  const updates = {
    learning_opt_out: learningOptOut,
    learning_opt_out_at: learningOptOut ? new Date().toISOString() : null,
  }

  const { error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', userId)

  if (error) {
    console.error('[learning-optout] update failed:', error)
    return c.json({ error: 'update failed' }, 500)
  }

  return c.json({ data: updates })
})

export default learningOptout
