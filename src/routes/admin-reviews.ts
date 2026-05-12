// ── Admin Reviews API ─────────────────────────────────────────────────
// BM v10 검수 대기열 + 검수 상태 전환
//
// 마이그레이션 052: sessions 테이블의 review_status / *_status 컬럼 사용
//
// 라우트:
//   GET  /api/admin/reviews                — 검수 대기열 + 상태별 카운트
//   POST /api/admin/reviews/:sessionId    — review_status 전환 (in_review/approved/rejected/needs_revision)
//   GET  /api/admin/sessions/:sessionId   — 단일 세션 상세 (검수용)

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import { formatDisplayTitle } from '../lib/displayTitle.js'

const adminReviews = new Hono()

adminReviews.use('/*', authMiddleware)
adminReviews.use('/*', adminMiddleware)

// 검수 상태 5단계 상태머신
const VALID_REVIEW = new Set([
  'pending',
  'in_review',
  'approved',
  'rejected',
  'needs_revision',
])

// 처리 흐름이 모두 done 인지 — pending → in_review 전환 가능 여부 체크용
// DB: gpu_upload_status / gpu_pii_status (BM v9 컬럼 충돌 회피)
function pipelineComplete(row: Record<string, unknown>): boolean {
  return (
    row.gpu_upload_status === 'done' &&
    row.stt_status === 'done' &&
    row.diarize_status === 'done' &&
    row.gpu_pii_status === 'done' &&
    row.quality_status === 'done'
  )
}

function isAllowedTransition(from: string, to: string, isPipelineComplete: boolean): boolean {
  // pending → in_review (파이프라인 완료 시만)
  if (from === 'pending' && to === 'in_review') return isPipelineComplete
  // in_review → approved | rejected | needs_revision
  if (from === 'in_review') return ['approved', 'rejected', 'needs_revision'].includes(to)
  // needs_revision → in_review (수정 후 재검수)
  if (from === 'needs_revision' && to === 'in_review') return true
  // approved / rejected 는 변경 X
  return false
}

// ── GET /api/admin/reviews ──────────────────────────────────────────
adminReviews.get('/reviews', async (c) => {
  const url = new URL(c.req.url)
  const reviewStatus = url.searchParams.get('review_status') ?? undefined
  const consentStatus = url.searchParams.get('consent_status') ?? undefined
  const qualityLow = url.searchParams.get('quality_low') === '1'
  const pipelineFailed = url.searchParams.get('pipeline_failed') === '1'
  const search = url.searchParams.get('q') ?? undefined
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50))
  const offset = (page - 1) * limit

  let query = supabaseAdmin
    .from('sessions')
    .select(
      'id, user_id, session_seq, created_at, date, duration, consent_status, consented_at, ' +
        'gpu_upload_status, gpu_uploaded_at, stt_status, stt_at, diarize_status, diarize_at, ' +
        'gpu_pii_status, gpu_pii_at, quality_status, quality_at, review_status',
      { count: 'exact' },
    )
    .order('consented_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1)

  if (reviewStatus && VALID_REVIEW.has(reviewStatus)) {
    query = query.eq('review_status', reviewStatus)
  }
  if (consentStatus) {
    query = query.eq('consent_status', consentStatus)
  }
  if (qualityLow) {
    // 저품질 우선 — quality_status = 'failed' 만 우선 표시 (시드 단계 단순화)
    query = query.eq('quality_status', 'failed')
  }
  if (pipelineFailed) {
    // 처리 흐름 5단계 중 어느 하나라도 failed — 이상 신호 탭 진입 시 활용
    query = query.or(
      'gpu_upload_status.eq.failed,stt_status.eq.failed,' +
        'diarize_status.eq.failed,gpu_pii_status.eq.failed,quality_status.eq.failed',
    )
  }
  if (search) {
    // ILIKE 검색 — title 또는 id prefix
    query = query.or(`title.ilike.%${search}%,id.ilike.${search}%`)
  }

  const { data, error, count } = await query
  if (error) {
    return c.json({ error: error.message }, 500)
  }

  // 상태별 카운트 (전체 — 필터 무관 — 5개 batch query)
  const counts = await Promise.all(
    ['pending', 'in_review', 'approved', 'rejected', 'needs_revision'].map((s) =>
      supabaseAdmin
        .from('sessions')
        .select('id', { count: 'exact', head: true })
        .eq('review_status', s),
    ),
  )

  // 현재 필터에 맞는 sessions 의 duration 전체 합산 (페이지네이션 무관)
  // — UX: "919건 (총 N시간)" 의 N 은 페이지가 아닌 필터 결과 전체 기준이어야 함
  let filteredDurationSec = 0
  {
    let durQuery = supabaseAdmin.from('sessions').select('duration')
    if (reviewStatus && VALID_REVIEW.has(reviewStatus)) {
      durQuery = durQuery.eq('review_status', reviewStatus)
    }
    if (consentStatus) {
      durQuery = durQuery.eq('consent_status', consentStatus)
    }
    if (qualityLow) {
      durQuery = durQuery.eq('quality_status', 'failed')
    }
    if (pipelineFailed) {
      durQuery = durQuery.or(
        'gpu_upload_status.eq.failed,stt_status.eq.failed,' +
          'diarize_status.eq.failed,gpu_pii_status.eq.failed,quality_status.eq.failed',
      )
    }
    if (search) {
      durQuery = durQuery.or(`title.ilike.%${search}%,id.ilike.${search}%`)
    }
    const { data: durRows } = await durQuery
    filteredDurationSec = (durRows ?? []).reduce(
      (sum, row) => sum + ((row as { duration?: number }).duration ?? 0),
      0,
    )
  }

  // 마이그레이션 052의 신규 컬럼은 supabase 타입 생성기에 아직 반영되지 않을 수 있어
  // 안전하게 Record 로 좁혀 사용한다.
  // DB → API 키 매핑: gpu_upload_status → upload_status, gpu_pii_status → pii_status
  // (프론트엔드는 BM v9 컬럼명 의식 X — 백엔드가 별칭 처리)
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  const sessions = rows.map((row) => ({
    id: row.id as string,
    user_id: row.user_id as string,
    // STAGE 6 — raw title 비노출. 합성 display_title 만.
    title: formatDisplayTitle(
      (row.session_seq as number | null) ?? null,
      (row.created_at as string | null) ?? null,
      (row.duration as number | null) ?? null,
    ),
    date: row.date as string,
    duration_seconds: (row.duration as number) ?? 0,
    consent_status: row.consent_status as string,
    consented_at: (row.consented_at as string) ?? null,
    upload_status: (row.gpu_upload_status as string) ?? 'pending',
    uploaded_at: (row.gpu_uploaded_at as string) ?? null,
    stt_status: (row.stt_status as string) ?? 'pending',
    stt_at: (row.stt_at as string) ?? null,
    diarize_status: (row.diarize_status as string) ?? 'pending',
    diarize_at: (row.diarize_at as string) ?? null,
    pii_status: (row.gpu_pii_status as string) ?? 'pending',
    pii_at: (row.gpu_pii_at as string) ?? null,
    quality_status: (row.quality_status as string) ?? 'pending',
    quality_at: (row.quality_at as string) ?? null,
    review_status: (row.review_status as string) ?? 'pending',
  }))

  return c.json({
    data: {
      sessions,
      total: count ?? 0,
      filteredDurationSec,
      pendingCount: counts[0].count ?? 0,
      inReviewCount: counts[1].count ?? 0,
      approvedCount: counts[2].count ?? 0,
      rejectedCount: counts[3].count ?? 0,
      needsRevisionCount: counts[4].count ?? 0,
    },
  })
})

// ── POST /api/admin/reviews/:sessionId ───────────────────────────────
adminReviews.post('/reviews/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const body = getBody<{ status?: string; note?: string }>(c)
  const status = body?.status

  if (!status || !VALID_REVIEW.has(status)) {
    return c.json({ error: 'invalid review status' }, 400)
  }

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('sessions')
    .select(
      'id, review_status, gpu_upload_status, stt_status, diarize_status, gpu_pii_status, quality_status',
    )
    .eq('id', sessionId)
    .single()

  if (fetchErr || !existing) {
    return c.json({ error: 'session not found' }, 404)
  }

  const from = (existing.review_status as string) ?? 'pending'
  const complete = pipelineComplete(existing)

  if (!isAllowedTransition(from, status, complete)) {
    return c.json(
      {
        error: `invalid transition: ${from} → ${status}` +
          (from === 'pending' && !complete ? ' (pipeline not complete)' : ''),
      },
      409,
    )
  }

  const { error: updateErr } = await supabaseAdmin
    .from('sessions')
    .update({ review_status: status })
    .eq('id', sessionId)

  if (updateErr) {
    return c.json({ error: updateErr.message }, 500)
  }

  return c.json({ data: { ok: true } })
})

// ── GET /api/admin/sessions/:sessionId ───────────────────────────────
adminReviews.get('/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single()
  if (error || !data) return c.json({ error: 'session not found' }, 404)
  // gpu_* → upload/pii API 키 별칭
  const row = data as unknown as Record<string, unknown>
  return c.json({
    data: {
      id: row.id as string,
      user_id: row.user_id as string,
      // STAGE 6 — raw title 비노출. 합성 display_title.
      title: formatDisplayTitle(
        (row.session_seq as number | null) ?? null,
        (row.created_at as string | null) ?? null,
        (row.duration as number | null) ?? null,
      ),
      date: row.date as string,
      duration_seconds: (row.duration as number) ?? 0,
      consent_status: row.consent_status as string,
      consented_at: row.consented_at as string,
      upload_status: (row.gpu_upload_status as string) ?? 'pending',
      stt_status: (row.stt_status as string) ?? 'pending',
      diarize_status: (row.diarize_status as string) ?? 'pending',
      pii_status: (row.gpu_pii_status as string) ?? 'pending',
      quality_status: (row.quality_status as string) ?? 'pending',
      review_status: (row.review_status as string) ?? 'pending',
    },
  })
})

// ── GET /api/admin/sessions  (검수 승인된 통화 목록 — 납품 페이지용) ──
adminReviews.get('/sessions', async (c) => {
  const url = new URL(c.req.url)
  const reviewStatus = url.searchParams.get('review_status') ?? undefined
  const search = url.searchParams.get('q') ?? undefined
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '100', 10) || 100))

  let query = supabaseAdmin
    .from('sessions')
    .select('id, session_seq, created_at, duration, consent_status, review_status')
    .order('consented_at', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (reviewStatus && VALID_REVIEW.has(reviewStatus)) {
    query = query.eq('review_status', reviewStatus)
  }
  if (search) {
    // STAGE 6.8 — raw title 매칭 (응답엔 미노출)
    query = query.or(`title.ilike.%${search}%,id.ilike.${search}%`)
  }

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json({
    data: (data ?? []).map((row) => {
      const r = row as unknown as Record<string, unknown>
      return {
        id: r.id as string,
        // STAGE 6 — 합성 display_title
        title: formatDisplayTitle(
          (r.session_seq as number | null) ?? null,
          (r.created_at as string | null) ?? null,
          (r.duration as number | null) ?? null,
        ),
        duration_seconds: (r.duration as number) ?? 0,
        consent_status: r.consent_status as string,
      }
    }),
  })
})

export default adminReviews
