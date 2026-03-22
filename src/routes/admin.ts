// ── Admin API Routes ───────────────────────────────────────────────────
// 관리자 페이지 전용 API (Clients, DeliveryProfiles, SKU Rules, Export Jobs, Billable Units)

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'
import { encryptId } from '../lib/crypto.js'
import {
  listObjects,
  listFolders,
  getSignedUrl,
  getSignedUrls,
  S3_AUDIO_BUCKET,
} from '../lib/s3.js'

const admin = new Hono()

// 모든 라우트에 인증 필수 (추후 관리자 권한 체크 추가 가능)
admin.use('/*', authMiddleware)

// ── 세션 행 → camelCase 변환 (sessions.ts의 sessionFromRow와 동일) ──────────

function sessionFromRow(row: Record<string, unknown>) {
  const rawId = row.id as string
  const rawUserId = (row.user_id as string) ?? null
  const rawPeerId = (row.peer_id as string) ?? null
  const rawAudioUrl = (row.audio_url as string) ?? null
  const rawCallRecordId = (row.call_record_id as string) ?? null
  const rawDupGroupId = (row.dup_group_id as string) ?? null
  const rawFileHash = (row.file_hash_sha256 as string) ?? null
  const rawAudioFP = (row.audio_fingerprint as string) ?? null
  const rawWavPath = (row.local_sanitized_wav_path as string) ?? null
  const rawTextPreview = (row.local_sanitized_text_preview as string) ?? null

  return {
    id: encryptId(rawId),
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
    hasDiarization: (row.has_diarization as boolean) ?? false,
    chunkCount: (row.chunk_count as number) ?? 0,
    audioUrl: rawAudioUrl ? encryptId(rawAudioUrl) : undefined,
    callRecordId: rawCallRecordId ? encryptId(rawCallRecordId) : undefined,
    dupStatus: (row.dup_status as any) ?? 'none',
    dupGroupId: rawDupGroupId ? encryptId(rawDupGroupId) : null,
    dupConfidence: (row.dup_confidence as number) ?? null,
    fileHashSha256: rawFileHash ? encryptId(rawFileHash) : null,
    audioFingerprint: rawAudioFP ? encryptId(rawAudioFP) : null,
    dupRepresentative: (row.dup_representative as boolean) ?? null,
    uploadStatus: (row.upload_status as any) ?? 'LOCAL',
    piiStatus: (row.pii_status as any) ?? 'CLEAR',
    shareScope: (row.share_scope as any) ?? 'PRIVATE',
    eligibleForShare: (row.eligible_for_share as boolean) ?? false,
    reviewAction: (row.review_action as any) ?? null,
    lockReason: (row.lock_reason as Record<string, unknown>) ?? null,
    lockStartMs: (row.lock_start_ms as number) ?? null,
    lockEndMs: (row.lock_end_ms as number) ?? null,
    localSanitizedWavPath: rawWavPath ? encryptId(rawWavPath) : null,
    localSanitizedTextPreview: rawTextPreview ? encryptId(rawTextPreview) : null,
    consentStatus: (row.consent_status as any) ?? 'locked',
    verifiedSpeaker: (row.verified_speaker as boolean) ?? false,
    userId: rawUserId ? encryptId(rawUserId) : null,
    peerId: rawPeerId ? encryptId(rawPeerId) : null,
    labelStatus: (row.label_status as any) ?? null,
    labelSource: (row.label_source as any) ?? null,
    labelConfidence: typeof row.label_confidence === 'number' ? row.label_confidence : null,
  }
}

// ── 세션 필터 쿼리 빌더 (sessions + users/stats 공유) ─────────────────────

type SessionFilterParams = {
  domains: string[]
  qualityGrades: string[]
  labelStatus?: string
  publicStatus?: string
  piiCleanedOnly: boolean
  hasAudioUrl: boolean
  diarizationStatus?: string
  transcriptSessionIds: string[] | null
  transcriptStatus?: string
  uploadStatuses: string[]
  dateFrom?: string
  dateTo?: string
}

function applySessionFilters(query: any, f: SessionFilterParams) {
  if (f.domains.length) {
    query = query.or(f.domains.map((d: string) => `labels->>domain.eq.${d}`).join(','))
  }
  if (f.qualityGrades.length) {
    const gradeConds: string[] = []
    if (f.qualityGrades.includes('A')) gradeConds.push('qa_score.gte.80')
    if (f.qualityGrades.includes('B')) gradeConds.push('and(qa_score.gte.60,qa_score.lt.80)')
    if (f.qualityGrades.includes('C')) gradeConds.push('qa_score.lt.60')
    if (gradeConds.length) query = query.or(gradeConds.join(','))
  }
  if (f.labelStatus === 'labeled') query = query.not('labels', 'is', null)
  else if (f.labelStatus === 'unlabeled') query = query.is('labels', null)
  if (f.publicStatus === 'public') query = query.eq('is_public', true)
  else if (f.publicStatus === 'private') query = query.eq('is_public', false)
  if (f.piiCleanedOnly) query = query.eq('is_pii_cleaned', true)
  if (f.hasAudioUrl) query = query.not('audio_url', 'is', null)
  if (f.diarizationStatus === 'done') query = query.eq('has_diarization', true)
  else if (f.diarizationStatus === 'none') query = query.eq('has_diarization', false)
  if (f.transcriptStatus === 'done' && f.transcriptSessionIds) {
    if (f.transcriptSessionIds.length) query = query.in('id', f.transcriptSessionIds)
    else query = query.eq('id', '__no_match__')
  } else if (f.transcriptStatus === 'none' && f.transcriptSessionIds) {
    if (f.transcriptSessionIds.length) query = query.not('id', 'in', `(${f.transcriptSessionIds.join(',')})`)
  }
  if (f.uploadStatuses.length) query = query.in('upload_status', f.uploadStatuses)
  if (f.dateFrom) query = query.gte('date', f.dateFrom)
  if (f.dateTo) query = query.lte('date', f.dateTo)
  return query
}

// ── Admin Me ─────────────────────────────────────────────────────────────

admin.get('/me', async (c) => {
  const userId = c.get('userId')

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.admin.getUserById(userId)

    if (error || !user) return c.json({ error: 'forbidden' }, 403)

    if (user.app_metadata?.role !== 'admin') {
      return c.json({ error: 'forbidden' }, 403)
    }

    return c.json({ user: { id: encryptId(user.id), email: encryptId(user.email!) } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Clients ─────────────────────────────────────────────────────────────

admin.get('/clients', async (c) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/clients', async (c) => {
  const client = getBody(c)

  try {
    const { error } = await supabaseAdmin.from('clients').upsert(client)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.delete('/clients/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { error } = await supabaseAdmin.from('clients').delete().eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Delivery Profiles ───────────────────────────────────────────────────

admin.get('/delivery-profiles', async (c) => {
  const clientId = c.req.query('clientId')

  try {
    let query = supabaseAdmin
      .from('delivery_profiles')
      .select('*')
      .order('created_at', { ascending: false })

    if (clientId) query = query.eq('client_id', clientId)

    const { data, error } = await query
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/delivery-profiles', async (c) => {
  const profile = getBody(c)

  try {
    const { error } = await supabaseAdmin.from('delivery_profiles').upsert(profile)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.delete('/delivery-profiles/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { error } = await supabaseAdmin.from('delivery_profiles').delete().eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Client SKU Rules ────────────────────────────────────────────────────

admin.get('/client-sku-rules', async (c) => {
  const clientId = c.req.query('clientId')

  if (!clientId) {
    return c.json({ error: 'clientId query parameter is required' }, 400)
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('client_sku_rules')
      .select('*')
      .eq('client_id', clientId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/client-sku-rules', async (c) => {
  const rule = getBody(c)

  try {
    const { error } = await supabaseAdmin.from('client_sku_rules').upsert(rule)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.delete('/client-sku-rules/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { error } = await supabaseAdmin.from('client_sku_rules').delete().eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── SKU Presets ─────────────────────────────────────────────────────────

admin.get('/sku-presets', async (c) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('sku_presets')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/sku-presets', async (c) => {
  const preset = getBody(c)

  try {
    const { error } = await supabaseAdmin.from('sku_presets').upsert(preset)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.delete('/sku-presets/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { error } = await supabaseAdmin.from('sku_presets').delete().eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Export Jobs ─────────────────────────────────────────────────────────

admin.get('/export-jobs', async (c) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('export_jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.get('/export-jobs/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { data, error } = await supabaseAdmin
      .from('export_jobs')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ data: null })
      }
      return c.json({ error: error.message }, 500)
    }

    return c.json({ data })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/export-jobs', async (c) => {
  const job = getBody(c)

  try {
    const { error } = await supabaseAdmin.from('export_jobs').upsert(job)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/export-jobs/:id/logs', async (c) => {
  const id = c.req.param('id')
  const { log } = getBody<{ log: unknown }>(c)

  try {
    // 기존 job 조회
    const { data: job, error: fetchError } = await supabaseAdmin
      .from('export_jobs')
      .select('logs')
      .eq('id', id)
      .single()

    if (fetchError || !job) {
      return c.json({ error: 'Job not found' }, 404)
    }

    // logs 배열에 추가
    const logs = Array.isArray(job.logs) ? [...job.logs, log] : [log]

    const { error } = await supabaseAdmin
      .from('export_jobs')
      .update({ logs })
      .eq('id', id)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.delete('/export-jobs/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const { error } = await supabaseAdmin.from('export_jobs').delete().eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Billable Units ──────────────────────────────────────────────────────

function billableUnitFromRow(row: Record<string, unknown>) {
  const rawId = row.id as string
  const rawSessionId = (row.session_id ?? row.sessionId) as string
  const rawUserId = (row.user_id ?? row.userId) as string

  return {
    id:               encryptId(rawId),
    sessionId:        rawUserId ? encryptId(rawSessionId) : null,
    minuteIndex:      (row.minute_index ?? row.minuteIndex) as number,
    effectiveSeconds: Number(row.effective_seconds ?? row.effectiveSeconds ?? 0),
    qualityGrade:     ((row.quality_grade ?? row.qualityGrade) as 'A' | 'B' | 'C') ?? 'C',
    qaScore:          Number(row.qa_score ?? row.qaScore ?? 0),
    qualityTier:      ((row.quality_tier ?? row.qualityTier) as string) ?? 'basic',
    labelSource:      ((row.label_source ?? row.labelSource) as string) ?? null,
    hasLabels:        ((row.has_labels ?? row.hasLabels) as boolean) ?? false,
    consentStatus:    ((row.consent_status ?? row.consentStatus) as string) ?? 'PRIVATE',
    piiStatus:        ((row.pii_status ?? row.piiStatus) as string) ?? 'CLEAR',
    lockStatus:       ((row.lock_status ?? row.lockStatus) as string) ?? 'available',
    lockedByJobId:    ((row.locked_by_job_id ?? row.lockedByJobId) as string) ?? null,
    sessionDate:      ((row.session_date ?? row.sessionDate) as string) ?? '',
    userId:           rawUserId ? encryptId(rawUserId) : null,
    sourceSessionIds: ((row.source_session_ids ?? row.sourceSessionIds) as string[]) ?? undefined,
    deviceContext:    ((row.device_context ?? row.deviceContext) as any) ?? undefined,
  }
}

admin.get('/billable-units', async (c) => {
  const qualityGrade = c.req.query('qualityGrade')?.split(',')
  const qualityTier = c.req.query('qualityTier')?.split(',')
  const consentStatus = c.req.query('consentStatus')
  const lockStatus = c.req.query('lockStatus')
  const userId = c.req.query('userId')
  const dateFrom = c.req.query('dateFrom')
  const dateTo = c.req.query('dateTo')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10), 1000)
  const offset = parseInt(c.req.query('offset') ?? '0', 10)

  try {
    let query = supabaseAdmin
      .from('billable_units')
      .select('*', { count: 'exact' })
      .order('session_date', { ascending: false })
      .range(offset, offset + limit - 1)

    if (qualityGrade?.length) query = query.in('quality_grade', qualityGrade)
    if (qualityTier?.length) query = query.in('quality_tier', qualityTier)
    if (consentStatus) query = query.eq('consent_status', consentStatus)
    if (lockStatus) query = query.eq('lock_status', lockStatus)
    if (userId) query = query.eq('user_id', userId)
    if (dateFrom && dateTo) {
      query = query.gte('session_date', dateFrom).lte('session_date', dateTo)
    }

    const { data, error, count } = await query
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: (data ?? []).map(billableUnitFromRow), count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/billable-units', async (c) => {
  const { units } = getBody<{ units: any[] }>(c)

  if (!Array.isArray(units) || units.length === 0) {
    return c.json({ error: 'Units array is required' }, 400)
  }

  try {
    const BATCH = 500
    for (let i = 0; i < units.length; i += BATCH) {
      const batch = units.slice(i, i + BATCH)
      const { error } = await supabaseAdmin.from('billable_units').upsert(batch)
      if (error) {
        return c.json({ error: error.message }, 500)
      }
    }

    return c.json({ data: { count: units.length, success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/billable-units/lock', async (c) => {
  const { unitIds, jobId } = getBody<{ unitIds: string[]; jobId: string }>(c)

  if (!Array.isArray(unitIds) || !jobId) {
    return c.json({ error: 'unitIds and jobId are required' }, 400)
  }

  try {
    const BATCH = 500
    let locked = 0

    for (let i = 0; i < unitIds.length; i += BATCH) {
      const batch = unitIds.slice(i, i + BATCH)
      const { error, count } = await supabaseAdmin
        .from('billable_units')
        .update({ lock_status: 'locked_for_job', locked_by_job_id: jobId })
        .in('id', batch)
        .eq('lock_status', 'available')

      if (error) break
      locked += count ?? batch.length
    }

    return c.json({ data: { locked } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/billable-units/unlock', async (c) => {
  const { jobId } = getBody<{ jobId: string }>(c)

  if (!jobId) {
    return c.json({ error: 'jobId is required' }, 400)
  }

  try {
    const { error } = await supabaseAdmin
      .from('billable_units')
      .update({ lock_status: 'available', locked_by_job_id: null })
      .eq('locked_by_job_id', jobId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/billable-units/mark-delivered', async (c) => {
  const { jobId } = getBody<{ jobId: string }>(c)

  if (!jobId) {
    return c.json({ error: 'jobId is required' }, 400)
  }

  try {
    const { error } = await supabaseAdmin
      .from('billable_units')
      .update({ lock_status: 'delivered' })
      .eq('locked_by_job_id', jobId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Sessions (Admin) ──────────────────────────────────────────────────

/**
 * GET /admin/sessions
 * 전체 세션 조회 (어드민 전용) — 필터·정렬·페이징 지원
 * Query params:
 *   - limit?: number (default 100, max 200)
 *   - offset?: number (default 0)
 *   - domains?: string[] (반복 append)
 *   - qualityGrades?: string[] ('A'|'B'|'C', 반복 append)
 *   - labelStatus?: 'labeled'|'unlabeled'
 *   - publicStatus?: 'public'|'private'
 *   - piiCleanedOnly?: 'true'
 *   - hasAudioUrl?: 'true'
 *   - diarizationStatus?: 'done'|'none'
 *   - transcriptStatus?: 'done'|'none'
 *   - uploadStatuses?: string[] (반복 append)
 *   - dateFrom?, dateTo?: string (YYYY-MM-DD)
 *   - sortBy?: 'date'|'qaScore'|'duration' (default 'date')
 *   - sortDir?: 'asc'|'desc' (default 'desc')
 */
admin.get('/sessions', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 200)
  const offset = Number(c.req.query('offset') ?? 0)
  const domains = c.req.queries('domains') ?? []
  const qualityGrades = c.req.queries('qualityGrades') ?? []
  const labelStatus = c.req.query('labelStatus')
  const publicStatus = c.req.query('publicStatus')
  const piiCleanedOnly = c.req.query('piiCleanedOnly') === 'true'
  const hasAudioUrl = c.req.query('hasAudioUrl') === 'true'
  const diarizationStatus = c.req.query('diarizationStatus')
  const transcriptStatus = c.req.query('transcriptStatus')
  const uploadStatuses = c.req.queries('uploadStatuses') ?? []
  const dateFrom = c.req.query('dateFrom')
  const dateTo = c.req.query('dateTo')
  const sortBy = c.req.query('sortBy') ?? 'date'
  const sortDir = c.req.query('sortDir') ?? 'desc'

  const sortColumn = sortBy === 'qaScore' ? 'qa_score' : sortBy === 'duration' ? 'duration' : 'date'
  const ascending = sortDir === 'asc'

  try {
    // transcriptStatus 필터: transcripts 테이블에서 session_id 목록 사전 조회
    let transcriptSessionIds: string[] | null = null
    if (transcriptStatus === 'done' || transcriptStatus === 'none') {
      const { data: tData } = await supabaseAdmin.from('transcripts').select('session_id')
      transcriptSessionIds = (tData ?? []).map((r: any) => r.session_id as string)
    }

    const filterParams: SessionFilterParams = {
      domains, qualityGrades, labelStatus, publicStatus,
      piiCleanedOnly, hasAudioUrl, diarizationStatus,
      transcriptSessionIds, transcriptStatus,
      uploadStatuses, dateFrom, dateTo,
    }

    let query = supabaseAdmin
      .from('sessions')
      .select('*', { count: 'exact' })
      .order(sortColumn, { ascending })
      .range(offset, offset + limit - 1)

    query = applySessionFilters(query, filterParams)

    const { data, error, count } = await query
    if (error) return c.json({ error: error.message }, 500)

    return c.json({
      data: (data ?? []).map(sessionFromRow),
      count: count ?? 0,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /admin/users/stats
 * 사용자별 세션 집계 (필터·페이징 지원)
 * Query params: 위 /sessions와 동일 필터 + sortBy: 'sessionCount'|'totalDuration'|'avgQaScore'
 */
admin.get('/users/stats', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 200)
  const offset = Number(c.req.query('offset') ?? 0)
  const domains = c.req.queries('domains') ?? []
  const qualityGrades = c.req.queries('qualityGrades') ?? []
  const labelStatus = c.req.query('labelStatus')
  const publicStatus = c.req.query('publicStatus')
  const piiCleanedOnly = c.req.query('piiCleanedOnly') === 'true'
  const hasAudioUrl = c.req.query('hasAudioUrl') === 'true'
  const diarizationStatus = c.req.query('diarizationStatus')
  const transcriptStatus = c.req.query('transcriptStatus')
  const uploadStatuses = c.req.queries('uploadStatuses') ?? []
  const dateFrom = c.req.query('dateFrom')
  const dateTo = c.req.query('dateTo')
  const userSortBy = c.req.query('sortBy') ?? 'sessionCount'
  const sortDir = c.req.query('sortDir') ?? 'desc'
  const ascending = sortDir === 'asc'

  try {
    // transcriptStatus 필터: session_id 목록 사전 조회
    let transcriptSessionIds: string[] | null = null
    if (transcriptStatus === 'done' || transcriptStatus === 'none') {
      const { data: tData } = await supabaseAdmin.from('transcripts').select('session_id')
      transcriptSessionIds = (tData ?? []).map((r: any) => r.session_id as string)
    }

    const filterParams: SessionFilterParams = {
      domains, qualityGrades, labelStatus, publicStatus,
      piiCleanedOnly, hasAudioUrl, diarizationStatus,
      transcriptSessionIds, transcriptStatus,
      uploadStatuses, dateFrom, dateTo,
    }

    // 필터 적용해 세션 전체 로드 (집계용, 페이징 없음)
    const PAGE = 1000
    const allSessions: any[] = []
    let from = 0

    while (true) {
      let query = supabaseAdmin
        .from('sessions')
        .select('id, user_id, duration, qa_score, labels, is_public')
        .range(from, from + PAGE - 1)

      query = applySessionFilters(query, filterParams)

      const { data, error } = await query
      if (error) return c.json({ error: error.message }, 500)
      if (!data?.length) break
      allSessions.push(...data)
      if (data.length < PAGE) break
      from += PAGE
    }

    // userId별 집계
    const groupMap = new Map<string, any[]>()
    for (const s of allSessions) {
      const key = s.user_id ?? '__null__'
      if (!groupMap.has(key)) groupMap.set(key, [])
      groupMap.get(key)!.push(s)
    }

    const groups = Array.from(groupMap.entries()).map(([key, sessions]) => {
      const userId = key === '__null__' ? null : key
      const totalDurationHours = sessions.reduce((sum: number, s: any) => sum + (s.duration ?? 0), 0) / 3600
      const avgQaScore = sessions.length
        ? Math.round(sessions.reduce((sum: number, s: any) => sum + (s.qa_score ?? 0), 0) / sessions.length)
        : 0
      const labeledRatio = sessions.length
        ? sessions.filter((s: any) => s.labels !== null).length / sessions.length
        : 0
      const publicCount = sessions.filter((s: any) => s.is_public).length
      const qualityDistribution = { A: 0, B: 0, C: 0 }
      for (const s of sessions) {
        const score = s.qa_score ?? 0
        if (score >= 80) qualityDistribution.A++
        else if (score >= 60) qualityDistribution.B++
        else qualityDistribution.C++
      }
      return {
        userId: userId ? encryptId(userId) : null,
        displayId: userId ? `${userId.slice(0, 8)}...` : '미인증 사용자',
        sessionCount: sessions.length,
        totalDurationHours,
        avgQaScore,
        labeledRatio,
        qualityDistribution,
        publicCount,
      }
    })

    // 정렬
    groups.sort((a, b) => {
      const dir = ascending ? 1 : -1
      if (userSortBy === 'totalDuration') return (a.totalDurationHours - b.totalDurationHours) * dir
      if (userSortBy === 'avgQaScore') return (a.avgQaScore - b.avgQaScore) * dir
      return (a.sessionCount - b.sessionCount) * dir
    })

    const total = groups.length
    const page = groups.slice(offset, offset + limit)

    return c.json({ data: page, count: total })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Transcripts (Admin) ──────────────────────────────────────────────────

/**
 * GET /admin/transcripts
 * 전체 전사 데이터 조회 (어드민 전용, user_id 필터 없음)
 * Query params:
 *   - limit?: number (default 500, max 1000)
 *   - offset?: number (default 0)
 */
admin.get('/transcripts', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 500), 1000)
  const offset = Number(c.req.query('offset') ?? 0)

  try {
    const { data, error, count } = await supabaseAdmin
      .from('transcripts')
      .select('session_id, user_id, text, summary, created_at, words', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return c.json({ error: error.message }, 500)

    const result = (data ?? []).map((row) => ({
      sessionId: row.session_id,
      userId: row.user_id,
      text: row.text,
      summary: row.summary ?? undefined,
      words: row.words ?? undefined,
      createdAt: row.created_at,
    }))

    return c.json({ data: result, count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Ledger Entries ──────────────────────────────────────────────────────

admin.get('/ledger-entries', async (c) => {
  const userId = c.req.query('userId')
  const status = c.req.query('status')
  const exportJobId = c.req.query('exportJobId')
  const buIds = c.req.query('buIds')?.split(',').filter(Boolean)

  try {
    const PAGE = 1000
    const all: any[] = []
    let from = 0

    while (true) {
      let query = supabaseAdmin
        .from('user_asset_ledger')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1)

      if (userId) query = query.eq('user_id', userId)
      if (status) query = query.eq('status', status)
      if (exportJobId) query = query.eq('export_job_id', exportJobId)
      if (buIds?.length) query = query.in('bu_id', buIds)

      const { data, error } = await query
      if (error) { console.warn('ledger-entries error:', error.message); break }
      if (!data || data.length === 0) break

      all.push(...data)
      if (data.length < PAGE) break
      from += PAGE
    }

    return c.json({ data: all })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/ledger-entries', async (c) => {
  const { entries } = getBody<{ entries: any[] }>(c)

  if (!Array.isArray(entries) || entries.length === 0) {
    return c.json({ error: 'entries array is required' }, 400)
  }

  try {
    const BATCH = 500
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH)
      const { error } = await supabaseAdmin.from('user_asset_ledger').upsert(batch)
      if (error) return c.json({ error: error.message }, 500)
    }
    return c.json({ data: { count: entries.length, success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/ledger-entries/update-status', async (c) => {
  const { ids, status, confirmedAmount } = getBody<{
    ids: string[]
    status: string
    confirmedAmount?: number
  }>(c)

  if (!Array.isArray(ids) || ids.length === 0 || !status) {
    return c.json({ error: 'ids and status are required' }, 400)
  }

  try {
    const now = new Date().toISOString()
    const updateFields: Record<string, unknown> = { status }

    if (status === 'confirmed') {
      updateFields.confirmed_at = now
      if (confirmedAmount != null) updateFields.amount_confirmed = confirmedAmount
    } else if (status === 'withdrawable') {
      updateFields.withdrawable_at = now
    } else if (status === 'paid') {
      updateFields.paid_at = now
    }

    const BATCH = 500
    let updated = 0
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH)
      const { error, count } = await supabaseAdmin
        .from('user_asset_ledger')
        .update(updateFields)
        .in('id', batch)
      if (error) return c.json({ error: error.message }, 500)
      updated += count ?? batch.length
    }

    return c.json({ data: { updated } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/ledger-entries/confirm-job', async (c) => {
  const { exportJobId, totalPayment } = getBody<{
    exportJobId: string
    totalPayment: number
  }>(c)

  if (!exportJobId || totalPayment == null) {
    return c.json({ error: 'exportJobId and totalPayment are required' }, 400)
  }

  try {
    // estimated 상태인 항목 조회
    const { data: rows, error: fetchError } = await supabaseAdmin
      .from('user_asset_ledger')
      .select('id, amount_high')
      .eq('export_job_id', exportJobId)
      .eq('status', 'estimated')

    if (fetchError) return c.json({ error: fetchError.message }, 500)
    if (!rows || rows.length === 0) return c.json({ data: { confirmed: 0 } })

    const totalHigh = rows.reduce((s: number, r: any) => s + (r.amount_high ?? 0), 0)
    if (totalHigh === 0) return c.json({ data: { confirmed: 0 } })

    const now = new Date().toISOString()
    let confirmed = 0

    for (const row of rows) {
      const ratio = (row.amount_high ?? 0) / totalHigh
      const amount = Math.round(totalPayment * ratio)
      const { error } = await supabaseAdmin
        .from('user_asset_ledger')
        .update({ amount_confirmed: amount, status: 'confirmed', confirmed_at: now })
        .eq('id', row.id)
      if (!error) confirmed++
    }

    return c.json({ data: { confirmed } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Delivery Records ─────────────────────────────────────────────────────

admin.get('/delivery-records', async (c) => {
  const clientId = c.req.query('clientId')

  if (!clientId) {
    return c.json({ error: 'clientId query parameter is required' }, 400)
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('delivery_records')
      .select('*')
      .eq('client_id', clientId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

admin.post('/delivery-records', async (c) => {
  const { buIds, clientId, exportJobId } = getBody<{
    buIds: string[]
    clientId: string
    exportJobId: string
  }>(c)

  if (!Array.isArray(buIds) || !clientId || !exportJobId) {
    return c.json({ error: 'buIds, clientId, exportJobId are required' }, 400)
  }

  try {
    const now = new Date().toISOString()
    const BATCH = 500
    for (let i = 0; i < buIds.length; i += BATCH) {
      const batch = buIds.slice(i, i + BATCH).map((buId) => ({
        bu_id: buId,
        client_id: clientId,
        export_job_id: exportJobId,
        delivered_at: now,
      }))
      const { error } = await supabaseAdmin
        .from('delivery_records')
        .upsert(batch, { onConflict: 'bu_id,client_id' })
      if (error) return c.json({ error: error.message }, 500)
    }

    return c.json({ data: { count: buIds.length, success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Admin Storage: WAV 목록 조회 ────────────────────────────────────────

/**
 * GET /admin/storage/wavs
 * 전체 유저 WAV 목록 조회 (어드민 전용)
 */
admin.get('/storage/wavs', async (c) => {
  try {
    // 최상위 "폴더" (userId) 목록 조회
    const userPrefixes = await listFolders(S3_AUDIO_BUCKET, '')

    type StorageWavEntry = { userId: string; sessionId: string; path: string }
    const result: StorageWavEntry[] = []

    for (const prefix of userPrefixes) {
      const userId = prefix.replace(/\/$/, '')

      const files = await listObjects(S3_AUDIO_BUCKET, prefix, 10000)

      for (const file of files) {
        if (!file.key.endsWith('.wav')) continue
        const fileName = file.key.split('/').pop() ?? ''
        const sessionId = fileName.replace('.wav', '')
        result.push({ userId, sessionId, path: file.key })
      }
    }

    return c.json({ data: result })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /admin/storage/signed-url
 * Admin signed URL 생성 (RLS 우회)
 * Body: { storagePath: string, expiresIn?: number }
 */
admin.post('/storage/signed-url', async (c) => {
  const { storagePath, expiresIn = 300 } = getBody<{ storagePath: string; expiresIn?: number }>(c)

  if (!storagePath) {
    return c.json({ error: 'Missing storagePath' }, 400)
  }

  try {
    const signedUrl = await getSignedUrl(S3_AUDIO_BUCKET, storagePath, expiresIn)

    return c.json({ data: { signedUrl } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Session Chunks: 청크 Signed URL 일괄 반환 ────────────────────────

/**
 * POST /admin/session-chunks/batch-signed-urls
 * session_chunks 테이블에서 세션별 청크 목록 조회 후 Signed URL 일괄 생성
 * Body: { sessionIds: string[] }
 * Response: { sessionId, minuteIndex, storagePath, signedUrl, durationSeconds }[]
 */
admin.post('/session-chunks/batch-signed-urls', async (c) => {
  const { sessionIds } = getBody<{ sessionIds: string[] }>(c)

  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return c.json({ error: 'sessionIds must be a non-empty array' }, 400)
  }

  try {
    // 1. session_chunks 조회
    const { data: chunks, error: dbError } = await supabaseAdmin
      .from('session_chunks')
      .select('session_id, chunk_index, storage_path, duration_sec')
      .in('session_id', sessionIds)
      .order('session_id', { ascending: true })
      .order('chunk_index', { ascending: true })

    if (dbError) return c.json({ error: dbError.message }, 500)
    if (!chunks || chunks.length === 0) return c.json({ data: [] })

    // 2. storage_path 목록 추출 → presigned URL 배치 생성
    const paths = chunks.map((r) => r.storage_path as string)
    const urlMap = await getSignedUrls(S3_AUDIO_BUCKET, paths, 600)

    // 4. 응답 조립 (signedUrl 없는 청크 제외)
    const result = chunks
      .filter((r) => urlMap.has(r.storage_path as string))
      .map((r) => ({
        sessionId: r.session_id as string,
        minuteIndex: r.chunk_index as number,
        storagePath: r.storage_path as string,
        signedUrl: urlMap.get(r.storage_path as string)!,
        durationSeconds: r.duration_sec as number,
      }))

    return c.json({ data: result })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Admin Transcript: 필터용 ID 목록 + 일괄 조회 ─────────────────────

/**
 * GET /admin/transcript-ids
 * transcript 있는 session_id 목록 반환
 */
admin.get('/transcript-ids', async (c) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('transcripts')
      .select('session_id')

    if (error) return c.json({ error: error.message }, 500)

    const ids = (data ?? []).map((row) => row.session_id as string)
    return c.json({ data: ids })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /admin/transcripts/bulk
 * 세션별 transcript 일괄 조회
 * Body: { sessionIds: string[] }
 */
admin.post('/transcripts/bulk', async (c) => {
  const { sessionIds } = getBody<{ sessionIds: string[] }>(c)

  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return c.json({ error: 'sessionIds array is required' }, 400)
  }

  try {
    // Supabase .in() 최대 약 1000개 제한 → 배치 처리
    const BATCH = 500
    const all: any[] = []

    for (let i = 0; i < sessionIds.length; i += BATCH) {
      const batch = sessionIds.slice(i, i + BATCH)
      const { data, error } = await supabaseAdmin
        .from('transcripts')
        .select('session_id, text, words, summary')
        .in('session_id', batch)

      if (error) return c.json({ error: error.message }, 500)
      if (data) all.push(...data)
    }

    const result = all.map((row) => ({
      sessionId: row.session_id,
      text: row.text,
      words: row.words ?? undefined,
      summary: row.summary ?? undefined,
    }))

    return c.json({ data: result })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Admin Storage-Session 동기화 ────────────────────────────────────────

/**
 * POST /admin/sync-audio-urls
 * storage WAV 목록 → sessions.audio_url 동기화
 */
admin.post('/sync-audio-urls', async (c) => {
  try {
    // 1. S3에서 WAV 목록 조회
    const userPrefixes = await listFolders(S3_AUDIO_BUCKET, '')

    type WavEntry = { sessionId: string; path: string }
    const wavEntries: WavEntry[] = []

    for (const prefix of userPrefixes) {
      const files = await listObjects(S3_AUDIO_BUCKET, prefix, 10000)

      for (const file of files) {
        if (!file.key.endsWith('.wav')) continue
        const fileName = file.key.split('/').pop() ?? ''
        const sessionId = fileName.replace('.wav', '')
        wavEntries.push({ sessionId, path: file.key })
      }
    }

    if (wavEntries.length === 0) {
      return c.json({ data: { updated: 0, total: 0 } })
    }

    // 2. audio_url이 null인 세션만 업데이트
    let updated = 0
    for (const entry of wavEntries) {
      const { error } = await supabaseAdmin
        .from('sessions')
        .update({ audio_url: entry.path })
        .eq('id', entry.sessionId)
        .is('audio_url', null)

      if (!error) updated++
    }

    return c.json({ data: { updated, total: wavEntries.length } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Reset All ───────────────────────────────────────────────────────────

admin.delete('/reset-all', async (c) => {
  const TABLES = [
    'sessions',
    'export_jobs',
    'billable_units',
    'error_logs',
    'funnel_events',
  ]

  const result: Record<string, number | string> = {}

  for (const table of TABLES) {
    try {
      const { error, count } = await supabaseAdmin
        .from(table)
        .delete({ count: 'exact' })
        .neq('id', '___impossible___')

      result[table] = error ? `ERROR: ${error.message}` : (count ?? 0)
    } catch (err: any) {
      result[table] = `ERROR: ${err.message}`
    }
  }

  return c.json({ data: { tables: result } })
})

export default admin
