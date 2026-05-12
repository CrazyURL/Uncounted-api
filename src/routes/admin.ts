// ── Admin API Routes ───────────────────────────────────────────────────
// 관리자 페이지 전용 API (Clients, DeliveryProfiles, SKU Rules, Export Jobs, Billable Units)

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import { encryptId } from '../lib/crypto.js'
import { formatDisplayTitle } from '../lib/displayTitle.js'
import metadataAdmin from './admin-metadata.js'
import {
  listObjects,
  listFolders,
  getSignedUrl,
  getSignedUrls,
  S3_AUDIO_BUCKET,
  S3_META_BUCKET,
} from '../lib/s3.js'

const admin = new Hono()

// 모든 라우트에 인증 + 관리자 권한 필수
admin.use('/*', authMiddleware)
admin.use('/*', adminMiddleware)

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

  // STAGE 6: title 응답 제거 — admin 은 합성 display_title 만 노출.
  // raw title 은 검색 매칭 조건절에만 사용, response payload 에는 절대 X.
  // sessions 테이블에 created_at 부재 — date 컬럼(YYYY-MM-DD) 사용.
  const sessionSeq = (row.session_seq as number | null) ?? null
  const sessionDate = (row.date as string | null) ?? null
  const duration = (row.duration as number | null) ?? null
  return {
    id: encryptId(rawId),
    title: formatDisplayTitle(sessionSeq, sessionDate, duration),
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

// ── utterances 테이블에서 session별 대표 labels 조회 ───────────────────────

type UtteranceLabelEntry = {
  labels: Record<string, unknown>
  labelSource: string | null
}

async function fetchUtteranceLabelsForSessions(
  sessionIds: string[],
): Promise<Map<string, UtteranceLabelEntry>> {
  const map = new Map<string, UtteranceLabelEntry>()
  if (sessionIds.length === 0) return map

  const BATCH = 500
  for (let i = 0; i < sessionIds.length; i += BATCH) {
    const batch = sessionIds.slice(i, i + BATCH)
    const { data } = await supabaseAdmin
      .from('utterances')
      .select('session_id, labels, label_source')
      .in('session_id', batch)
      .not('labels', 'is', null)
      .order('id', { ascending: true })

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const sid = row.session_id as string
      // 세션당 첫 번째 라벨이 있는 utterance를 대표로 사용
      if (!map.has(sid)) {
        map.set(sid, {
          labels: row.labels as Record<string, unknown>,
          labelSource: (row.label_source as string) ?? null,
        })
      }
    }
  }

  return map
}

// ── 세션 필터 쿼리 빌더 (sessions + users/stats 공유) ─────────────────────

type SessionFilterParams = {
  domains: string[]
  qualityGrades: string[]
  labelStatus?: string
  labeledSessionIds: string[] | null  // utterances 테이블 기반 라벨 보유 session_id 목록
  publicStatus?: string
  piiCleanedOnly: boolean
  hasAudioUrl: boolean
  diarizationStatus?: string
  transcriptSessionIds: string[] | null
  transcriptStatus?: string
  uploadStatuses: string[]
  dateFrom?: string
  dateTo?: string
  consentStatus?: string  // 'both_agreed' | 'user_only' | 'locked' | 'all' (운영 검수용 필터)
  searchTitle?: string  // STAGE 6.8 — raw title 매칭 (응답엔 비노출, 검색만)
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
  if (f.labelStatus === 'labeled' && f.labeledSessionIds) {
    if (f.labeledSessionIds.length) query = query.in('id', f.labeledSessionIds)
    else query = query.eq('id', '__no_match__')
  } else if (f.labelStatus === 'unlabeled' && f.labeledSessionIds) {
    if (f.labeledSessionIds.length) query = query.not('id', 'in', `(${f.labeledSessionIds.join(',')})`)
  }
  if (f.publicStatus === 'public') query = query.eq('is_public', true)
  else if (f.publicStatus === 'private') query = query.eq('is_public', false)
  if (f.piiCleanedOnly) query = query.eq('is_pii_cleaned', true)
  if (f.hasAudioUrl) query = query.not('audio_url', 'is', null)
  // BM v10 — has_diarization boolean 폐기 → diarize_status TEXT 컬럼 사용 (마이그 052)
  if (f.diarizationStatus === 'done') query = query.eq('diarize_status', 'done')
  else if (f.diarizationStatus === 'none') query = query.neq('diarize_status', 'done')
  // BM v10 — transcripts 테이블 폐기 → stt_status TEXT 컬럼 사용 (마이그 052)
  if (f.transcriptStatus === 'done') query = query.eq('stt_status', 'done')
  else if (f.transcriptStatus === 'none') query = query.neq('stt_status', 'done')
  if (f.uploadStatuses.length) query = query.in('upload_status', f.uploadStatuses)
  if (f.consentStatus && f.consentStatus !== 'all') {
    query = query.eq('consent_status', f.consentStatus)
  }
  if (f.dateFrom) query = query.gte('date', f.dateFrom)
  if (f.dateTo) query = query.lte('date', f.dateTo)
  // STAGE 6.8 — raw title ilike 검색 (응답엔 title 자체 비노출, 매칭에만 사용)
  if (f.searchTitle && f.searchTitle.length > 0) {
    query = query.ilike('title', `%${f.searchTitle}%`)
  }
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

// ── Export Jobs, Billable Units → admin-exports.ts로 이동됨 ─────────────

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
  const consentStatus = c.req.query('consentStatus')
  // STAGE 6.8 — title 매칭 검색 (raw title 응답엔 비노출, 매칭만)
  const searchTitle = (c.req.query('q') ?? '').trim()
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

    // labelStatus 필터: utterances 테이블에서 labels 보유 session_id 목록 사전 조회
    let labeledSessionIds: string[] | null = null
    if (labelStatus === 'labeled' || labelStatus === 'unlabeled') {
      const { data: lData } = await supabaseAdmin
        .from('utterances')
        .select('session_id')
        .not('labels', 'is', null)
      labeledSessionIds = [...new Set((lData ?? []).map((r: any) => r.session_id as string))]
    }

    const filterParams: SessionFilterParams = {
      domains, qualityGrades, labelStatus, labeledSessionIds, publicStatus,
      piiCleanedOnly, hasAudioUrl, diarizationStatus,
      transcriptSessionIds, transcriptStatus,
      uploadStatuses, dateFrom, dateTo, consentStatus,
      searchTitle: searchTitle || undefined,
    }

    let query = supabaseAdmin
      .from('sessions')
      .select('*', { count: 'exact' })
      .order(sortColumn, { ascending })
      .range(offset, offset + limit - 1)

    query = applySessionFilters(query, filterParams)

    const { data, error, count } = await query
    if (error) return c.json({ error: error.message }, 500)

    // utterances 테이블에서 session별 대표 labels 조회하여 병합
    const rows = (data ?? []) as Record<string, unknown>[]
    const sessionIds = rows.map((r) => r.id as string).filter(Boolean)
    const uttLabelsMap = await fetchUtteranceLabelsForSessions(sessionIds)

    return c.json({
      data: rows.map((row) => {
        const mapped = sessionFromRow(row)
        const uttLabels = uttLabelsMap.get(row.id as string)
        if (uttLabels) {
          return { ...mapped, labels: uttLabels.labels, labelSource: uttLabels.labelSource }
        }
        return mapped
      }),
      count: count ?? 0,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /admin/sessions/aggregate
 * 필터링된 세션의 합계 — count, totalDurationSec.
 * 페이지에 표시되는 100건 외에 전체 카운트/통화시간을 한 번에 보여주기 위한 집계 전용 엔드포인트.
 * GET /admin/sessions 와 동일한 query 필터 (limit/offset/sortBy 무시).
 */
admin.get('/sessions/aggregate', async (c) => {
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
  const consentStatus = c.req.query('consentStatus')

  try {
    let transcriptSessionIds: string[] | null = null
    if (transcriptStatus === 'done' || transcriptStatus === 'none') {
      const { data: tData } = await supabaseAdmin.from('transcripts').select('session_id')
      transcriptSessionIds = (tData ?? []).map((r: any) => r.session_id as string)
    }

    let labeledSessionIds: string[] | null = null
    if (labelStatus === 'labeled' || labelStatus === 'unlabeled') {
      const { data: lData } = await supabaseAdmin
        .from('utterances')
        .select('session_id')
        .not('labels', 'is', null)
      labeledSessionIds = [...new Set((lData ?? []).map((r: any) => r.session_id as string))]
    }

    const filterParams: SessionFilterParams = {
      domains, qualityGrades, labelStatus, labeledSessionIds, publicStatus,
      piiCleanedOnly, hasAudioUrl, diarizationStatus,
      transcriptSessionIds, transcriptStatus,
      uploadStatuses, dateFrom, dateTo, consentStatus,
    }

    // 1000건씩 페이지네이션해서 duration 합산 (count 는 첫 페이지에서 exact)
    const PAGE = 1000
    let totalDurationSec = 0
    let count = 0
    let from = 0
    while (true) {
      let q = supabaseAdmin
        .from('sessions')
        .select('duration', { count: 'exact' })
        .range(from, from + PAGE - 1)
      q = applySessionFilters(q, filterParams)
      const { data, error, count: c0 } = await q
      if (error) return c.json({ error: error.message }, 500)
      if (from === 0) count = c0 ?? 0
      const rows = data ?? []
      for (const r of rows) {
        const d = Number((r as any).duration)
        if (Number.isFinite(d)) totalDurationSec += d
      }
      if (rows.length < PAGE) break
      from += PAGE
    }

    return c.json({ data: { count, totalDurationSec } })
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
  const consentStatus = c.req.query('consentStatus')
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

    // labelStatus 필터: utterances 테이블에서 labels 보유 session_id 목록 사전 조회
    let labeledSessionIds: string[] | null = null
    if (labelStatus === 'labeled' || labelStatus === 'unlabeled') {
      const { data: lData } = await supabaseAdmin
        .from('utterances')
        .select('session_id')
        .not('labels', 'is', null)
      labeledSessionIds = [...new Set((lData ?? []).map((r: any) => r.session_id as string))]
    }

    const filterParams: SessionFilterParams = {
      domains, qualityGrades, labelStatus, labeledSessionIds, publicStatus,
      piiCleanedOnly, hasAudioUrl, diarizationStatus,
      transcriptSessionIds, transcriptStatus,
      uploadStatuses, dateFrom, dateTo, consentStatus,
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

// ── Ledger Entries, Delivery Records → admin-exports.ts로 이동됨 ────────

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
 * GET /admin/storage/metas
 * 전체 유저 Meta JSONL 목록 조회 (어드민 전용)
 */
admin.get('/storage/metas', async (c) => {
  try {
    const userPrefixes = await listFolders(S3_META_BUCKET, '')

    type StorageMetaEntry = { userId: string; batchId: string; path: string }
    const result: StorageMetaEntry[] = []

    for (const prefix of userPrefixes) {
      const userId = prefix.replace(/\/$/, '')
      const files = await listObjects(S3_META_BUCKET, prefix, 1000)

      for (const file of files) {
        if (!file.key.endsWith('.jsonl')) continue
        const fileName = file.key.split('/').pop() ?? ''
        const batchId = fileName.replace('.jsonl', '')
        result.push({ userId, batchId, path: file.key })
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
 * Body: { storagePath: string, expiresIn?: number, bucket?: 'audio' | 'meta' }
 */
admin.post('/storage/signed-url', async (c) => {
  const { storagePath, expiresIn = 300, bucket = 'audio' } = getBody<{ storagePath: string; expiresIn?: number; bucket?: 'audio' | 'meta' }>(c)

  if (!storagePath) {
    return c.json({ error: 'Missing storagePath' }, 400)
  }

  const targetBucket = bucket === 'meta' ? S3_META_BUCKET : S3_AUDIO_BUCKET

  try {
    const signedUrl = await getSignedUrl(targetBucket, storagePath, expiresIn)

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

// ── POST /admin/consent/notify-withdrawal ────────────────────────────────
// 관리자가 납품처에 동의 철회 통지 완료 후 호출.
// 해당 사용자의 withdrawal_notified_at을 현재 시각으로 설정.

admin.post('/consent/notify-withdrawal', async (c) => {
  const { userId } = getBody<{ userId: string }>(c)

  if (!userId) {
    return c.json({ error: 'userId is required' }, 400)
  }

  try {
    const now = new Date().toISOString()
    const { error } = await supabaseAdmin
      .from('users_profile')
      .update({ withdrawal_notified_at: now, updated_at: now })
      .eq('user_id', userId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { userId, withdrawal_notified_at: now } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── PUT /admin/sessions/consent-force-update ────────────────────────────
// 테스트 데이터 동의 강제 전환 (어드민 전용)
// 입력: { sessionIds: string[], consentStatus: 'both_agreed' }
// 효과: sessions.consent_status = 'both_agreed', billable_units.consent_status = 'PUBLIC_CONSENTED'

admin.put('/sessions/consent-force-update', async (c) => {
  const { sessionIds, consentStatus } = getBody<{ sessionIds: string[]; consentStatus: string }>(c)

  const ALLOWED_STATUSES = ['both_agreed']
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return c.json({ error: 'sessionIds 배열이 필요합니다' }, 400)
  }
  if (!ALLOWED_STATUSES.includes(consentStatus)) {
    return c.json({ error: `consentStatus는 ${ALLOWED_STATUSES.join(' | ')} 중 하나여야 합니다` }, 400)
  }
  if (sessionIds.length > 100) {
    return c.json({ error: '한 번에 최대 100개까지 처리 가능합니다' }, 400)
  }

  try {
    // upload_status = 'uploaded' 인 세션만 처리 (업로드 중인 세션 제외)
    const { data: uploadedSessions, error: fetchErr } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .in('id', sessionIds)
      .eq('upload_status', 'uploaded')

    if (fetchErr) throw fetchErr

    const eligibleIds = (uploadedSessions ?? []).map((s: { id: string }) => s.id)
    if (eligibleIds.length === 0) {
      return c.json({ data: { updated: 0, skipped: sessionIds.length, consentStatus } })
    }

    const { error: sessErr } = await supabaseAdmin
      .from('sessions')
      .update({ consent_status: 'both_agreed' })
      .in('id', eligibleIds)

    if (sessErr) throw sessErr

    const { error: buErr } = await supabaseAdmin
      .from('billable_units')
      .update({ consent_status: 'PUBLIC_CONSENTED' })
      .in('session_id', eligibleIds)

    if (buErr) throw buErr

    return c.json({ data: { updated: eligibleIds.length, skipped: sessionIds.length - eligibleIds.length, consentStatus } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Metadata Events ───────────────────────────────────────────────────
// admin-metadata.ts로 분리됨
admin.route('/metadata', metadataAdmin)

export default admin
