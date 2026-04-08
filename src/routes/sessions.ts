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
 * STT 완료 후 audio_metrics + has_diarization + upload_status 업데이트
 * (Android SttProcessingService 호출)
 *
 * NOTE: transcript는 sessions 테이블 컬럼이 아님 — POST /transcripts/:id로 별도 저장.
 *       클라이언트가 보내더라도 무시한다.
 */
sessions.patch('/:id', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const { audio_metrics, has_diarization, upload_status, pii_status } = getBody<{
    audio_metrics?: unknown
    has_diarization?: boolean
    upload_status?: string
    pii_status?: string
  }>(c)

  try {
    if (audio_metrics === undefined && has_diarization === undefined
        && upload_status === undefined && pii_status === undefined) {
      return c.json({ error: 'No fields to update' }, 400)
    }

    // audio_metrics / has_diarization 업데이트
    const updatePayload: Record<string, unknown> = {}
    if (audio_metrics !== undefined)  updatePayload.audio_metrics  = audio_metrics
    if (has_diarization !== undefined) updatePayload.has_diarization = has_diarization

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

    // pii_status 업데이트
    if (pii_status !== undefined) {
      await supabaseAdmin
        .from('sessions')
        .update({ pii_status })
        .eq('id', sessionId)
        .eq('user_id', userId)
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
 * POST /sessions/:id/utterances/complete
 * 세션 발화 업로드 완료 신호
 * Body (암호화): { totalCount, uploadedCount, failedCount }
 */
sessions.post('/:id/utterances/complete', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const { totalCount, uploadedCount } = getBody<{
    totalCount: number
    uploadedCount: number
    failedCount?: number
  }>(c)

  if (totalCount === undefined || uploadedCount === undefined) {
    return c.json({ error: 'Missing totalCount or uploadedCount' }, 400)
  }

  try {
    const uploadStatus = uploadedCount === totalCount ? 'complete' : 'partial'

    const { error } = await supabaseAdmin
      .from('sessions')
      .update({
        utterance_count:         totalCount,
        utterance_upload_status: uploadStatus,
      })
      .eq('id', sessionId)
      .eq('user_id', userId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { ok: true, uploadStatus } })
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
