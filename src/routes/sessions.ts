// ── Sessions API Routes ────────────────────────────────────────────────
// sessionMapper.ts 로직을 백엔드 API로 분리

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase'
import { authMiddleware } from '../lib/middleware'

const sessions = new Hono()

// 모든 라우트에 인증 필수
sessions.use('/*', authMiddleware)

// ── 타입 변환 헬퍼 ──────────────────────────────────────────────────────

function sessionFromRow(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    title: row.title as string,
    date: row.date as string,
    duration: row.duration as number,
    qaScore: (row.qa_score as number) ?? 0,
    contributionScore: (row.contribution_score as number) ?? 0,
    labels: row.labels as any,
    strategyLocked: (row.strategy_locked as boolean) ?? false,
    assetType: (row.asset_type as any) ?? '업무/회의',
    audioMetrics: null,
    isPublic: (row.is_public as boolean) ?? false,
    visibilityStatus: (row.visibility_status as any) ?? 'PRIVATE',
    visibilitySource: (row.visibility_source as any) ?? 'MANUAL',
    visibilityConsentVersion: (row.visibility_consent_version as string) ?? null,
    visibilityChangedAt: (row.visibility_changed_at as string) ?? null,
    status: ((row.status as any) === 'pending' ? 'uploaded' : (row.status as any)) ?? 'uploaded',
    isPiiCleaned: (row.is_pii_cleaned as boolean) ?? false,
    chunkCount: (row.chunk_count as number) ?? 0,
    audioUrl: (row.audio_url as string) ?? undefined,
    callRecordId: (row.call_record_id as string) ?? undefined,
    dupStatus: (row.dup_status as any) ?? 'none',
    dupGroupId: (row.dup_group_id as string) ?? null,
    dupConfidence: (row.dup_confidence as number) ?? null,
    fileHashSha256: (row.file_hash_sha256 as string) ?? null,
    audioFingerprint: (row.audio_fingerprint as string) ?? null,
    dupRepresentative: (row.dup_representative as boolean) ?? null,
    uploadStatus: (row.upload_status as any) ?? 'LOCAL',
    piiStatus: (row.pii_status as any) ?? 'CLEAR',
    shareScope: (row.share_scope as any) ?? 'PRIVATE',
    eligibleForShare: (row.eligible_for_share as boolean) ?? false,
    reviewAction: (row.review_action as any) ?? null,
    lockReason: (row.lock_reason as Record<string, unknown>) ?? null,
    lockStartMs: (row.lock_start_ms as number) ?? null,
    lockEndMs: (row.lock_end_ms as number) ?? null,
    localSanitizedWavPath: (row.local_sanitized_wav_path as string) ?? null,
    localSanitizedTextPreview: (row.local_sanitized_text_preview as string) ?? null,
    consentStatus: (row.consent_status as any) ?? 'locked',
    verifiedSpeaker: (row.verified_speaker as boolean) ?? false,
    userId: (row.user_id as string) ?? null,
    peerId: (row.peer_id as string) ?? null,
    labelStatus: (row.label_status as any) ?? null,
    labelSource: (row.label_source as any) ?? null,
    labelConfidence: typeof row.label_confidence === 'number' ? row.label_confidence : null,
  }
}

function sessionToRow(s: any) {
  return {
    id: s.id,
    title: s.title,
    date: s.date,
    duration: s.duration,
    qa_score: s.qaScore ?? 0,
    contribution_score: s.contributionScore ?? 0,
    labels: s.labels,
    strategy_locked: s.strategyLocked ?? false,
    asset_type: s.assetType ?? '업무/회의',
    is_public: s.isPublic,
    visibility_status: s.visibilityStatus,
    visibility_source: s.visibilitySource,
    visibility_consent_version: s.visibilityConsentVersion,
    visibility_changed_at: s.visibilityChangedAt,
    status: s.status,
    is_pii_cleaned: s.isPiiCleaned,
    chunk_count: s.chunkCount,
    audio_url: s.audioUrl,
    call_record_id: s.callRecordId,
    upload_status: s.uploadStatus ?? 'LOCAL',
    pii_status: s.piiStatus ?? 'CLEAR',
    share_scope: s.shareScope ?? 'PRIVATE',
    eligible_for_share: s.eligibleForShare ?? false,
    review_action: s.reviewAction ?? null,
    lock_reason: s.lockReason ?? null,
    lock_start_ms: s.lockStartMs ?? null,
    lock_end_ms: s.lockEndMs ?? null,
    local_sanitized_wav_path: s.localSanitizedWavPath ?? null,
    local_sanitized_text_preview: s.localSanitizedTextPreview ?? null,
    consent_status: s.consentStatus ?? 'locked',
    verified_speaker: s.verifiedSpeaker ?? false,
    user_id: s.userId ?? null,
    peer_id: s.peerId ?? null,
    label_status: s.labelStatus ?? null,
    label_source: s.labelSource ?? null,
    label_confidence: s.labelConfidence ?? null,
  }
}

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
  const body = await c.req.json()
  const sessionsData = body.sessions as any[]

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
      .upsert(rows)
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
 * PUT /sessions/:id/labels
 * 라벨 업데이트
 */
sessions.put('/:id/labels', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const { labels } = await c.req.json()

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
  } = await c.req.json()

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
