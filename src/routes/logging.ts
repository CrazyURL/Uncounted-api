// ── Logging API Routes ─────────────────────────────────────────────────
// 퍼널 이벤트 및 에러 로그 배치 전송 API

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase'
import { getBody } from '../lib/middleware'

const logging = new Hono()

// 인증은 선택적 (익명 로그도 허용)
// userId는 클라이언트에서 전송된 값 사용

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

  try {
    const rows = events.map((e) => ({
      id: e.id,
      step: e.step,
      timestamp: e.timestamp,
      date_bucket: e.date_bucket,
      user_id: e.user_id ?? null,
      meta: e.meta ?? null,
    }))

    const { error } = await supabaseAdmin
      .from('funnel_events')
      .insert(rows)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({
      data: {
        count: rows.length,
        success: true,
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
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

  try {
    const rows = logs.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      level: e.level,
      message: e.message,
      stack: e.stack ?? null,
      context: e.context ?? null,
      user_id: e.userId ?? null,
      device_info: e.deviceInfo ?? null,
    }))

    const { error } = await supabaseAdmin
      .from('error_logs')
      .upsert(rows, { onConflict: 'id' })

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({
      data: {
        count: rows.length,
        success: true,
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default logging
