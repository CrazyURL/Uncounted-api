// ── Sessions API Routes ────────────────────────────────────────────────
// sessionMapper.ts 로직을 백엔드 API로 분리

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'
import { sessionFromRow, sessionToRow } from './sessions-helpers.js'

const sessions = new Hono()

// 모든 라우트에 인증 필수
sessions.use('/*', authMiddleware)

// ── API 엔드포인트 ──────────────────────────────────────────────────────

/**
 * GET /sessions
 * 사용자의 모든 세션 조회 (페이징)
 */
sessions.get('/', async (c) => {
  const userId = c.get('userId') as string
  const page = parseInt(c.req.query('page') ?? '1', 10)
  const limit = Math.min(parseInt(c.req.query('limit') ?? '1000', 10), 1000)
  const from = (page - 1) * limit
  const to = from + limit - 1

  try {
    const { data, error, count } = await supabaseAdmin
      .from('sessions')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .range(from, to)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({
      data: data?.map(sessionFromRow) ?? [],
      count: count ?? 0,
      page,
      limit,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /sessions/:id
 * 세션 상세 조회
 */
sessions.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')

  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ error: 'Session not found' }, 404)
      }
      return c.json({ error: error.message }, 500)
    }

    return c.json({ data: sessionFromRow(data) })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /sessions/batch
 * 세션 배치 upsert (최대 500건)
 */
sessions.post('/batch', async (c) => {
  const userId = c.get('userId') as string
  const { sessions: sessionsData } = getBody<{ sessions: any[] }>(c)

  if (!Array.isArray(sessionsData) || sessionsData.length === 0) {
    return c.json({ error: 'Invalid or empty sessions array' }, 400)
  }

  if (sessionsData.length > 500) {
    return c.json({ error: 'Maximum 500 sessions per batch' }, 400)
  }

  try {
    // user_id 스탬프 (RLS 필수)
    const stamped = sessionsData.map((s) => ({
      ...s,
      userId: s.userId || userId,
    }))

    // DB 컬럼으로 변환
    const rows = stamped.map(sessionToRow);

    const { data, error } = await supabaseAdmin
      .from('sessions')
      .upsert(rows, { onConflict: 'id' })
      .select()

    if (error) {
      return c.json({ error: error.message }, 500)
    }


    return c.json({
      data: data?.map(sessionFromRow) ?? [],
      count: data?.length ?? 0,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * PATCH /sessions/:id
 * STT 완료 후 transcript + audio_metrics 업데이트 (Android SttProcessingService 호출)
 */
sessions.patch('/:id', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const { transcript, audio_metrics, upload_status } = getBody<{
    transcript?: string
    audio_metrics?: unknown
    upload_status?: string
  }>(c)

  try {
    if (transcript === undefined && audio_metrics === undefined && upload_status === undefined) {
      return c.json({ error: 'No fields to update' }, 400)
    }

    // transcript / audio_metrics 업데이트 (조건 없음)
    const updatePayload: Record<string, unknown> = {}
    if (transcript !== undefined)    updatePayload.transcript    = transcript
    if (audio_metrics !== undefined) updatePayload.audio_metrics = audio_metrics

    if (Object.keys(updatePayload).length > 0) {
      const { error } = await supabaseAdmin
        .from('sessions')
        .update(updatePayload)
        .eq('id', sessionId)
        .eq('user_id', userId)
      if (error) return c.json({ error: error.message }, 500)
    }

    // upload_status 별도 업데이트 — 이미 UPLOADED면 덮어씌우지 않음
    if (upload_status !== undefined) {
      await supabaseAdmin
        .from('sessions')
        .update({ upload_status })
        .eq('id', sessionId)
        .eq('user_id', userId)
        .neq('upload_status', 'UPLOADED')
      // 0 rows affected (이미 UPLOADED) 는 정상 — 에러 무시
    }

    return c.json({ data: { ok: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * PUT /sessions/:id/label-status
 * 자동 라벨링 신뢰도 + 상태 업데이트 (Android LabelApiClient / JS postSttPipeline 호출)
 */
sessions.put('/:id/label-status', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const { label_status, label_source, label_confidence } = getBody<{
    label_status: 'AUTO' | 'RECOMMENDED' | 'REVIEW'
    label_source?: string
    label_confidence?: number
  }>(c)

  if (!label_status) {
    return c.json({ error: 'label_status is required' }, 400)
  }

  try {
    const { error } = await supabaseAdmin
      .from('sessions')
      .update({
        label_status,
        label_source: label_source ?? null,
        label_confidence: label_confidence ?? null,
      })
      .eq('id', sessionId)
      .eq('user_id', userId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { ok: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * PUT /sessions/:id/labels
 * 라벨 업데이트
 */
sessions.put('/:id/labels', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const { labels } = getBody<{ labels: unknown }>(c)

  if (!labels) {
    return c.json({ error: 'Missing labels field' }, 400)
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .update({ labels })
      .eq('id', sessionId)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ error: 'Session not found' }, 404)
      }
      return c.json({ error: error.message }, 500)
    }

    return c.json({ data: sessionFromRow(data) })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * PUT /sessions/:id/visibility
 * 공개 상태 업데이트
 */
sessions.put('/:id/visibility', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const {
    isPublic,
    visibilityStatus,
    visibilitySource,
    visibilityConsentVersion,
    visibilityChangedAt,
  } = getBody<{
    isPublic: boolean
    visibilityStatus: string
    visibilitySource: string
    visibilityConsentVersion: string
    visibilityChangedAt: string
  }>(c)

  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .update({
        is_public: isPublic,
        visibility_status: visibilityStatus,
        visibility_source: visibilitySource,
        visibility_consent_version: visibilityConsentVersion,
        visibility_changed_at: visibilityChangedAt,
      })
      .eq('id', sessionId)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ error: 'Session not found' }, 404)
      }
      return c.json({ error: error.message }, 500)
    }

    return c.json({ data: sessionFromRow(data) })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * PATCH /sessions/:id/diarization
 * 화자분리 상태 업데이트
 * Body: { hasDiarization: boolean }
 */
sessions.patch('/:id/diarization', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const { hasDiarization } = getBody<{ hasDiarization: boolean }>(c)

  if (typeof hasDiarization !== 'boolean') {
    return c.json({ error: 'hasDiarization (boolean) is required' }, 400)
  }

  try {
    const { error } = await supabaseAdmin
      .from('sessions')
      .update({ has_diarization: hasDiarization })
      .eq('id', sessionId)
      .eq('user_id', userId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * PATCH /sessions/:id/dup
 * 중복 상태 업데이트 (클라이언트 측 중복 감지 결과 반영)
 * Body: { dupStatus: 'none' | 'duplicate' | 'representative', dupGroupId?: string | null }
 */
sessions.patch('/:id/dup', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const { dupStatus, dupGroupId } = getBody<{
    dupStatus: 'none' | 'duplicate' | 'representative'
    dupGroupId?: string | null
  }>(c)

  if (!dupStatus) {
    return c.json({ error: 'dupStatus is required' }, 400)
  }

  try {
    const { error } = await supabaseAdmin
      .from('sessions')
      .update({ dup_status: dupStatus, dup_group_id: dupGroupId ?? null })
      .eq('id', sessionId)
      .eq('user_id', userId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * DELETE /sessions/:id
 * 세션 삭제
 */
sessions.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')

  try {
    const { error } = await supabaseAdmin
      .from('sessions')
      .delete()
      .eq('id', sessionId)
      .eq('user_id', userId)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default sessions
