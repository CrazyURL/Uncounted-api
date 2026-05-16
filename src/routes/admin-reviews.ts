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
import { checkSessionAutoApproval } from '../lib/piiRisk.js'

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

// 처리 흐름이 모두 done/skipped 인지 — pending → in_review 전환 가능 여부 체크용
// DB: gpu_upload_status / gpu_pii_status (BM v9 컬럼 충돌 회피)
function pipelineComplete(row: Record<string, unknown>): boolean {
  const terminal = (v: unknown) => v === 'done' || v === 'skipped'
  return (
    terminal(row.gpu_upload_status) &&
    terminal(row.stt_status) &&
    terminal(row.diarize_status) &&
    terminal(row.gpu_pii_status) &&
    terminal(row.auto_label_status) &&
    terminal(row.quality_status)
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

function deriveGrade(score: number | null): 'A' | 'B' | 'C' | null {
  if (score == null) return null
  if (score >= 80) return 'A'
  if (score >= 50) return 'B'
  return 'C'
}

// ── GET /api/admin/reviews ──────────────────────────────────────────
adminReviews.get('/reviews', async (c) => {
  const url = new URL(c.req.url)
  const reviewStatus = url.searchParams.get('review_status') ?? undefined
  const qualityLow = url.searchParams.get('quality_low') === '1'
  const pipelineFailed = url.searchParams.get('pipeline_failed') === '1'
  const piiFlag = url.searchParams.get('pii_flag') === '1'
  const qualityGradeMin = url.searchParams.get('quality_grade_min') ?? undefined
  const search = url.searchParams.get('q') ?? undefined
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50))
  const offset = (page - 1) * limit
  const pipelineState = url.searchParams.get('pipeline_state') ?? undefined
  const sortBy = url.searchParams.get('sort_by')
  const sortDir = url.searchParams.get('sort_dir') ?? 'desc'
  const colMap: Record<string, string> = { date: 'date', duration: 'duration' }
  const orderCol = sortBy && colMap[sortBy] ? colMap[sortBy] : 'consented_at'
  const ascending = sortDir === 'asc'

  // pii_flag 필터: pii_intervals 있는 발화가 존재하는 세션 ID 선조회
  let piiSessionIds: string[] | null = null
  if (piiFlag) {
    const { data: piiRows } = await supabaseAdmin
      .from('utterances')
      .select('session_id')
      .filter('pii_intervals', 'neq', '[]')
      .limit(5000)
    piiSessionIds = [...new Set((piiRows ?? []).map((r) => (r as Record<string, unknown>).session_id as string))]
    if (piiSessionIds.length === 0) {
      return c.json({
        data: {
          sessions: [], total: 0, filteredDurationSec: 0,
          pendingCount: 0, inReviewCount: 0, approvedCount: 0, rejectedCount: 0, needsRevisionCount: 0,
        },
      })
    }
  }

  // quality_grade_min=C 필터: quality_grade='C' 발화가 존재하는 세션 ID 선조회
  let qualitySessionIds: string[] | null = null
  if (qualityGradeMin === 'C') {
    const { data: qualRows } = await supabaseAdmin
      .from('utterances')
      .select('session_id')
      .or('quality_grade.eq.C,and(quality_grade.is.null,quality_score.lt.50)')
      .limit(5000)
    qualitySessionIds = [...new Set((qualRows ?? []).map((r) => (r as Record<string, unknown>).session_id as string))]
    if (qualitySessionIds.length === 0) {
      return c.json({
        data: {
          sessions: [], total: 0, filteredDurationSec: 0,
          pendingCount: 0, inReviewCount: 0, approvedCount: 0, rejectedCount: 0, needsRevisionCount: 0,
        },
      })
    }
  }

  let query = supabaseAdmin
    .from('sessions')
    .select(
      'id, user_id, pid, session_seq, date, duration, consent_status, consented_at, ' +
        'gpu_upload_status, gpu_uploaded_at, stt_status, stt_at, diarize_status, diarize_at, ' +
        'gpu_pii_status, gpu_pii_at, auto_label_status, label_at, quality_status, quality_at, review_status, utterance_count',
      { count: 'exact' },
    )
    .eq('consent_status', 'both_agreed')
    .order(orderCol, { ascending, nullsFirst: false })
    .range(offset, offset + limit - 1)

  if (reviewStatus && VALID_REVIEW.has(reviewStatus)) {
    query = query.eq('review_status', reviewStatus)
  }
  if (qualityLow) {
    query = query.eq('quality_status', 'failed')
  }
  if (pipelineFailed) {
    query = query.or(
      'gpu_upload_status.eq.failed,stt_status.eq.failed,' +
        'diarize_status.eq.failed,gpu_pii_status.eq.failed,auto_label_status.eq.failed,quality_status.eq.failed',
    )
  }
  if (pipelineState === 'idle') {
    query = query
      .eq('gpu_upload_status', 'pending')
      .eq('stt_status', 'pending')
      .eq('diarize_status', 'pending')
      .eq('gpu_pii_status', 'pending')
      .eq('auto_label_status', 'pending')
      .eq('quality_status', 'pending')
  } else if (pipelineState === 'running') {
    query = query.or(
      'gpu_upload_status.eq.running,stt_status.eq.running,diarize_status.eq.running,' +
        'gpu_pii_status.eq.running,auto_label_status.eq.running,quality_status.eq.running',
    )
  } else if (pipelineState === 'label_skipped') {
    query = query.eq('auto_label_status', 'skipped')
  } else if (pipelineState === 'waiting') {
    // 일부 단계 완료, 실행 중 없음, 미완료 단계 존재 (파이프라인 정체 세션)
    const stageNotActive = (col: string) =>
      `${col}.is.null,and(${col}.neq.running,${col}.neq.failed)`
    query = query
      .or(stageNotActive('gpu_upload_status'))
      .or(stageNotActive('stt_status'))
      .or(stageNotActive('diarize_status'))
      .or(stageNotActive('gpu_pii_status'))
      .or(stageNotActive('auto_label_status'))
      .or(stageNotActive('quality_status'))
    // 적어도 하나의 단계는 완료(done/skipped)
    query = query.or(
      'gpu_upload_status.in.(done,skipped),stt_status.in.(done,skipped),' +
        'diarize_status.in.(done,skipped),gpu_pii_status.in.(done,skipped),' +
        'auto_label_status.in.(done,skipped),quality_status.in.(done,skipped)',
    )
    // 적어도 하나의 단계는 미완료(pending/null)
    query = query.or(
      'gpu_upload_status.is.null,gpu_upload_status.eq.pending,' +
        'stt_status.is.null,stt_status.eq.pending,' +
        'diarize_status.is.null,diarize_status.eq.pending,' +
        'gpu_pii_status.is.null,gpu_pii_status.eq.pending,' +
        'auto_label_status.is.null,auto_label_status.eq.pending,' +
        'quality_status.is.null,quality_status.eq.pending',
    )
  } else if (pipelineState === 'stuck') {
    // 단계가 running 중이나 이전 단계 완료 후 30분 초과 (처리 병목)
    const threshold = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    query = query.or(
      `and(stt_status.eq.running,gpu_uploaded_at.lt.${threshold}),` +
        `and(diarize_status.eq.running,stt_at.lt.${threshold}),` +
        `and(gpu_pii_status.eq.running,diarize_at.lt.${threshold}),` +
        `and(auto_label_status.eq.running,gpu_pii_at.lt.${threshold}),` +
        `and(quality_status.eq.running,label_at.lt.${threshold})`,
    )
  }
  if (piiSessionIds !== null) {
    query = query.in('id', piiSessionIds)
  }
  if (qualitySessionIds !== null) {
    query = query.in('id', qualitySessionIds)
  }
  if (search) {
    query = query.or(`title.ilike.%${search}%,id.ilike.${search}%`)
  }

  const { data, error, count } = await query
  if (error) {
    return c.json({ error: error.message }, 500)
  }

  // 상태별 카운트 (both_agreed 기준 — 5개 batch query)
  const counts = await Promise.all(
    ['pending', 'in_review', 'approved', 'rejected', 'needs_revision'].map((s) =>
      supabaseAdmin
        .from('sessions')
        .select('id', { count: 'exact', head: true })
        .eq('review_status', s)
        .eq('consent_status', 'both_agreed'),
    ),
  )

  // 현재 필터에 맞는 sessions 의 duration 전체 합산 (페이지네이션 무관)
  let filteredDurationSec = 0
  {
    let durQuery = supabaseAdmin.from('sessions').select('duration').eq('consent_status', 'both_agreed')
    if (reviewStatus && VALID_REVIEW.has(reviewStatus)) {
      durQuery = durQuery.eq('review_status', reviewStatus)
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
    if (piiSessionIds !== null) {
      durQuery = durQuery.in('id', piiSessionIds)
    }
    if (qualitySessionIds !== null) {
      durQuery = durQuery.in('id', qualitySessionIds)
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

  // DB → API 키 매핑: gpu_upload_status → upload_status, gpu_pii_status → pii_status
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  const sessionIds = rows.map((r) => r.id as string)

  // 발화 배치 조회 — pii/quality/speakers 집계용
  const piiCountBySession = new Map<string, number>()
  const gradeBySession = new Map<string, 'A' | 'B' | 'C' | null>()
  const qualityScoreSumBySession = new Map<string, number>()
  const qualityScoreCountBySession = new Map<string, number>()
  const snrDbSumBySession = new Map<string, number>()
  const snrDbCountBySession = new Map<string, number>()
  const speechRatioSumBySession = new Map<string, number>()
  const speechRatioCountBySession = new Map<string, number>()
  type PiiSample = { startSec: number; endSec: number; maskType: string | null; piiType: string | null }
  const piiSamplesBySession = new Map<string, PiiSample[]>()
  type SpeakerInfo = {
    speaker_label: string
    speaker_role: string | null
    speaker_gender: string | null
    speaker_voice_age_range: string | null
    speaker_speech_age_range: string | null
    speaker_relation: string | null
    speaker_accent_group: string | null
    speaker_region_group: string | null
    utterance_count: number
    total_duration_sec: number
  }
  const speakersBySession = new Map<string, SpeakerInfo[]>()
  const utteranceCountBySpeaker = new Map<string, number>()
  const durationSecBySpeaker = new Map<string, number>()

  if (sessionIds.length > 0) {
    const { data: uttRows } = await supabaseAdmin
      .from('utterances')
      .select('session_id, quality_grade, pii_intervals, quality_score, snr_db, speech_ratio, speaker_label, duration_sec')
      .in('session_id', sessionIds)
      .limit(50000)

    for (const utt of uttRows ?? []) {
      const row = utt as Record<string, unknown>
      const sid = row.session_id as string

      const piiIntervals = row.pii_intervals as unknown[]
      if (Array.isArray(piiIntervals) && piiIntervals.length > 0) {
        piiCountBySession.set(sid, (piiCountBySession.get(sid) ?? 0) + 1)
        const samples = piiSamplesBySession.get(sid) ?? []
        if (samples.length < 5) {
          for (const iv of piiIntervals) {
            if (samples.length >= 5) break
            const ivRow = iv as Record<string, unknown>
            samples.push({
              startSec: ivRow.startSec as number,
              endSec: ivRow.endSec as number,
              maskType: (ivRow.maskType as string | null) ?? null,
              piiType: (ivRow.piiType as string | null) ?? null,
            })
          }
          piiSamplesBySession.set(sid, samples)
        }
      }

      const g = (row.quality_grade as 'A' | 'B' | 'C' | null) ?? deriveGrade(row.quality_score as number | null)
      if (g) {
        const prev = gradeBySession.get(sid) ?? null
        if (prev === null || (prev === 'A' && (g === 'B' || g === 'C')) || (prev === 'B' && g === 'C')) {
          gradeBySession.set(sid, g)
        }
      }

      const qs = row.quality_score as number | null
      if (qs != null) {
        qualityScoreSumBySession.set(sid, (qualityScoreSumBySession.get(sid) ?? 0) + qs)
        qualityScoreCountBySession.set(sid, (qualityScoreCountBySession.get(sid) ?? 0) + 1)
      }
      const snr = row.snr_db as number | null
      if (snr != null) {
        snrDbSumBySession.set(sid, (snrDbSumBySession.get(sid) ?? 0) + snr)
        snrDbCountBySession.set(sid, (snrDbCountBySession.get(sid) ?? 0) + 1)
      }
      const sr = row.speech_ratio as number | null
      if (sr != null) {
        speechRatioSumBySession.set(sid, (speechRatioSumBySession.get(sid) ?? 0) + sr)
        speechRatioCountBySession.set(sid, (speechRatioCountBySession.get(sid) ?? 0) + 1)
      }

      const spLabel = row.speaker_label as string | null
      if (spLabel) {
        const key = `${sid}-${spLabel}`
        utteranceCountBySpeaker.set(key, (utteranceCountBySpeaker.get(key) ?? 0) + 1)
        const dur = row.duration_sec as number | null
        durationSecBySpeaker.set(key, (durationSecBySpeaker.get(key) ?? 0) + (dur ?? 0))
      }
    }

    for (const sid of sessionIds) {
      if (!gradeBySession.has(sid)) gradeBySession.set(sid, null)
    }

    const sessionPidMap = new Map<string, string>()
    for (const r of rows) {
      const pid = r.pid as string | null
      if (pid) sessionPidMap.set(r.id as string, pid)
    }
    const uniquePids = [...new Set(sessionPidMap.values())]
    const profileByPid = new Map<string, { accent_group: string | null; region_group: string | null }>()
    if (uniquePids.length > 0) {
      const { data: profileRows } = await supabaseAdmin
        .from('users_profile')
        .select('pid, accent_group, region_group')
        .in('pid', uniquePids)
      for (const p of profileRows ?? []) {
        const pr = p as Record<string, unknown>
        profileByPid.set(pr.pid as string, {
          accent_group: pr.accent_group as string | null,
          region_group: pr.region_group as string | null,
        })
      }
    }

    const { data: spRows } = await supabaseAdmin
      .from('session_speakers')
      .select('session_id, speaker_label, speaker_role, speaker_gender, speaker_voice_age_range, speaker_speech_age_range, speaker_relation')
      .in('session_id', sessionIds)
    for (const sp of spRows ?? []) {
      const spRow = sp as Record<string, unknown>
      const sid = spRow.session_id as string
      const arr = speakersBySession.get(sid) ?? []
      const spLabelVal = spRow.speaker_label as string
      const spRoleVal = spRow.speaker_role as string | null
      const speakerKey = `${sid}-${spLabelVal}`
      const sessionPid = sessionPidMap.get(sid)
      const profile = spRoleVal === 'self' && sessionPid ? profileByPid.get(sessionPid) : undefined
      arr.push({
        speaker_label: spLabelVal,
        speaker_role: spRoleVal,
        speaker_gender: spRow.speaker_gender as string | null,
        speaker_voice_age_range: spRow.speaker_voice_age_range as string | null,
        speaker_speech_age_range: spRow.speaker_speech_age_range as string | null,
        speaker_relation: spRow.speaker_relation as string | null,
        speaker_accent_group: profile?.accent_group ?? null,
        speaker_region_group: profile?.region_group ?? null,
        utterance_count: utteranceCountBySpeaker.get(speakerKey) ?? 0,
        total_duration_sec: Math.round((durationSecBySpeaker.get(speakerKey) ?? 0) * 10) / 10,
      })
      speakersBySession.set(sid, arr)
    }
  }

  const sessions = rows.map((row) => {
    const sid = row.id as string
    const piiCount = piiCountBySession.get(sid) ?? 0

    const qsCount = qualityScoreCountBySession.get(sid) ?? 0
    const snrCount = snrDbCountBySession.get(sid) ?? 0
    const srCount = speechRatioCountBySession.get(sid) ?? 0

    return {
      id: sid,
      user_id: row.user_id as string,
      title: formatDisplayTitle(
        (row.session_seq as number | null) ?? null,
        (row.date as string | null) ?? null,
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
      auto_label_status: (row.auto_label_status as string) ?? 'pending',
      label_at: (row.label_at as string) ?? null,
      quality_status: (row.quality_status as string) ?? 'pending',
      quality_at: (row.quality_at as string) ?? null,
      review_status: (row.review_status as string) ?? 'pending',
      pii_flag: piiCount > 0,
      pii_count: piiCount,
      quality_grade_min: gradeBySession.get(sid) ?? null,
      quality_score_avg: qsCount > 0 ? Math.round((qualityScoreSumBySession.get(sid)! / qsCount) * 10) / 10 : null,
      snr_db_avg: snrCount > 0 ? Math.round((snrDbSumBySession.get(sid)! / snrCount) * 10) / 10 : null,
      speech_ratio_avg: srCount > 0 ? Math.round((speechRatioSumBySession.get(sid)! / srCount) * 1000) / 1000 : null,
      pii_interval_samples: piiSamplesBySession.get(sid) ?? [],
      speakers: speakersBySession.get(sid) ?? [],
    }
  })

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
// 주의: bulk-auto-approve 가 :sessionId 패턴에 매칭되지 않도록 명시 차단
adminReviews.post('/reviews/:sessionId{[0-9a-f-]+}', async (c) => {
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

// ── POST /api/admin/reviews/bulk-auto-approve (STAGE 12) ──────────────
//
// 자동 승인 가능한 세션을 일괄 review_status='approved' 로 전환.
//
// 자동 승인 조건 (모든 utterance 대상, excluded 제외):
//   1. quality_grade='A'
//   2. text 에 숫자 7자리+ 없음
//   3. duration_seconds >= 1.0
//   4. transcript_text 비어있지 않음
//   5. speaker_id 정상 할당
// + 통화 위험도 not high (분산 PII / 인증정보 키워드 없음)
//
// body:
//   - dryRun?: boolean  → true 면 카운트/사유만 반환, DB 변경 X (기본 false)
//   - sessionIds?: string[]  → 지정 세션만 검사 (없으면 in_review 전체)
//
// 응답:
//   { approved: N, skipped: M, details: [{sessionId, eligible, reasons}] }
adminReviews.post('/reviews/bulk-auto-approve', async (c) => {
  const body = getBody<{ dryRun?: boolean; sessionIds?: string[] }>(c)
  const dryRun = body?.dryRun ?? false

  // 대상 세션 선정 — in_review + 파이프라인 완료
  let sessionQuery = supabaseAdmin
    .from('sessions')
    .select('id, review_status, gpu_upload_status, stt_status, diarize_status, gpu_pii_status, quality_status')
    .eq('review_status', 'in_review')

  if (body?.sessionIds && body.sessionIds.length > 0) {
    sessionQuery = sessionQuery.in('id', body.sessionIds)
  }

  const { data: sessionRows, error: sessErr } = await sessionQuery
  if (sessErr) return c.json({ error: sessErr.message }, 500)

  const candidateSessions = (sessionRows ?? []).filter((s) => pipelineComplete(s as Record<string, unknown>))
  const candidateIds = candidateSessions.map((s) => s.id as string)

  if (candidateIds.length === 0) {
    return c.json({ data: { approved: 0, skipped: 0, details: [] } })
  }

  // 모든 utterances 한 번에 로드 (5000건 cap 가정)
  const { data: utts, error: uttErr } = await supabaseAdmin
    .from('utterances')
    .select('id, session_id, transcript_text, duration_seconds, speaker_id, quality_grade, review_status')
    .in('session_id', candidateIds)
    .limit(50000)

  if (uttErr) return c.json({ error: uttErr.message }, 500)

  // session_id 별 그루핑
  const byId = new Map<string, Array<typeof utts[number]>>()
  for (const u of utts ?? []) {
    const k = u.session_id as string
    if (!byId.has(k)) byId.set(k, [])
    byId.get(k)!.push(u)
  }

  const eligible: string[] = []
  const details: Array<{ sessionId: string; eligible: boolean; reasons: string[] }> = []

  for (const sid of candidateIds) {
    const sessionUtts = (byId.get(sid) ?? []).map((u) => ({
      id: u.id as string,
      text: (u.transcript_text as string | null) ?? null,
      duration_seconds: Number(u.duration_seconds ?? 0),
      speaker_id: (u.speaker_id as string | null) ?? null,
      quality_grade: (u.quality_grade as string | null) ?? null,
      review_status: (u.review_status as string) ?? 'pending',
    }))
    const check = checkSessionAutoApproval(sessionUtts)
    details.push({ sessionId: sid, eligible: check.eligible, reasons: check.reasons.slice(0, 5) })
    if (check.eligible) eligible.push(sid)
  }

  if (dryRun) {
    return c.json({
      data: { approved: 0, skipped: candidateIds.length - eligible.length, eligibleCount: eligible.length, details },
    })
  }

  // 실제 일괄 업데이트
  if (eligible.length > 0) {
    const { error: updateErr } = await supabaseAdmin
      .from('sessions')
      .update({ review_status: 'approved', label_source: 'auto:bulk_review' })
      .in('id', eligible)
    if (updateErr) return c.json({ error: updateErr.message }, 500)
  }

  return c.json({
    data: {
      approved: eligible.length,
      skipped: candidateIds.length - eligible.length,
      details,
    },
  })
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
        (row.date as string | null) ?? null,
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
    .select('id, session_seq, date, duration, consent_status, review_status')
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
          (r.date as string | null) ?? null,
          (r.duration as number | null) ?? null,
        ),
        duration_seconds: (r.duration as number) ?? 0,
        consent_status: r.consent_status as string,
      }
    }),
  })
})

export default adminReviews
