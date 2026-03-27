// ── Logging API Routes ─────────────────────────────────────────────────
// 퍼널 이벤트 및 에러 로그 배치 전송 API

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { getBody, optionalAuthMiddleware } from '../lib/middleware.js'

const logging = new Hono()

// 인증은 선택적 (익명 로그도 허용)
// userId는 인증 토큰에서만 추출 (클라이언트 제공값 무시)
logging.use('/*', optionalAuthMiddleware)

// ── API 엔드포인트 ──────────────────────────────────────────────────────

/**
 * POST /logging/funnel
 * 퍼널 이벤트 배치 전송
 */
logging.post('/funnel', async (c) => {
  const { events } = getBody<{ events: any[] }>(c)

  if (!Array.isArray(events) || events.length === 0) {
    return c.json({ error: 'Events array is required' }, 400)
  }

  const userId = (c.get('userId') as string | undefined) ?? null

  try {
    const rows = events.map((e) => ({
      id: e.id,
      step: e.step,
      timestamp: e.timestamp,
      date_bucket: e.date_bucket,
      user_id: userId,
      meta: e.meta ?? null,
    }))

    const { error } = await supabaseAdmin
      .from('funnel_events')
      .upsert(rows, { onConflict: 'id' })

    if (error) {
      console.error('funnel upsert error:', error)
      return c.json({ error: 'Internal Server Error' }, 500)
    }

    return c.json({
      data: {
        count: rows.length,
        success: true,
      },
    })
  } catch (err: any) {
    console.error('funnel handler error:', err)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

/**
 * POST /logging/errors
 * 에러 로그 배치 전송
 */
logging.post('/errors', async (c) => {
  const { logs } = getBody<{ logs: any[] }>(c)

  if (!Array.isArray(logs) || logs.length === 0) {
    return c.json({ error: 'Logs array is required' }, 400)
  }

  const userId = (c.get('userId') as string | undefined) ?? null

  try {
    const rows = logs.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      level: e.level,
      message: e.message,
      stack: e.stack ?? null,
      context: e.context ?? null,
      user_id: userId,
      device_info: e.deviceInfo ?? null,
    }))

    const { error } = await supabaseAdmin
      .from('error_logs')
      .upsert(rows, { onConflict: 'id' })

    if (error) {
      console.error('error_logs upsert error:', error)
      return c.json({ error: 'Internal Server Error' }, 500)
    }

    return c.json({
      data: {
        count: rows.length,
        success: true,
      },
    })
  } catch (err: any) {
    console.error('errors handler error:', err)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

export default logging
