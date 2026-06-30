// ── Admin Utterances v2 API (BM v10 발화 단위 정산) ───────────────────
// 마이그레이션 055 — utterances 에 duration_seconds / unit_price_krw / settled_at 추가
//
// BU 폐기 — billable_units 테이블 대신 utterances 가 정산 단위.
// 본 라우트는 utterance 단위 조회 + 정산 상태 표시 전용.
//
// 라우트:
//   GET /api/admin/utterances-v2 — 발화 목록 (필터 + 페이지네이션)
//   GET /api/admin/utterances-v2/stats — 정산 합계 / 미정산 카운트
//
// 기존 admin-utterances.ts 와 충돌 방지를 위해 -v2 suffix.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware } from '../lib/middleware.js'
import { formatDisplayTitle } from '../lib/displayTitle.js'
import { HOURLY_RATE_KRW } from '../lib/pricing.js'
import { getSignedUrl, S3_AUDIO_BUCKET } from '../lib/s3.js'
import { maskKnownNames } from '../lib/piiNameMask.js'

const adminUtterancesV2 = new Hono()

adminUtterancesV2.use('/*', authMiddleware)
adminUtterancesV2.use('/*', adminMiddleware)

adminUtterancesV2.get('/utterances-v2', async (c) => {
  const url = new URL(c.req.url)
  const settled = url.searchParams.get('settled')  // 'yes' | 'no' | null
  const review = url.searchParams.get('review')  // 'pending' | 'excluded' | null
  const sessionId = url.searchParams.get('session_id') ?? undefined
  const search = url.searchParams.get('q') ?? undefined
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  // BM v10 admin 트리는 한 페이지에 모든 발화 표시 (세션 단위 그룹) — cap 5000.
  // 대량 데이터 시 추후 sessions 단위 page 로 분리.
  const limit = Math.min(5000, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50))
  const offset = (page - 1) * limit
  const orderBy = url.searchParams.get('order_by') ?? 'session_id_desc'

  let query = supabaseAdmin
    .from('utterances')
    .select(
      'id, session_id, speaker_id, session_speaker_id, segment_id, start_ms, end_ms, transcript_text, duration_seconds, unit_price_krw, settled_at, review_status, exclude_reason, reviewed_at, quality_grade, quality_review_status, quality_exclusion_reason, emotion, emotion_confidence, dialog_act, dialog_act_confidence, label_source, auto_label_model_version, utterance_form, honorific_level, confidence_tier, review_flags, review_priority_score, sessions(session_seq, date, duration, review_status, consent_status), session_speakers!session_speaker_id(speaker_role, speaker_gender), session_segments!segment_id(topic)',
      { count: 'exact' },
    )

  if (orderBy === 'created_at_asc') {
    query = query.order('session_id', { ascending: true }).order('start_ms', { ascending: true })
  } else {
    // default: created_at_desc — newest sessions first, utterances within session in order
    query = query.order('session_id', { ascending: false }).order('start_ms', { ascending: true })
  }
  query = query.range(offset, offset + limit - 1)

  if (settled === 'yes') query = query.not('settled_at', 'is', null)
  else if (settled === 'no') query = query.is('settled_at', null)
  if (review === 'pending' || review === 'excluded') query = query.eq('review_status', review)
  if (sessionId) query = query.eq('session_id', sessionId)
  if (search) query = query.ilike('transcript_text', `%${search}%`)

  const { data, error, count } = await query
  if (error) return c.json({ error: error.message }, 500)

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>

  // H2b — 사람 emotion 라벨 보강 읽기 (새로고침 후 배지 유지용).
  // utterances.emotion(모델 출력)은 절대 건드리지 않음 — 별도 테이블 utterance_human_labels.
  // 정렬: updated_at desc → id desc 로 결정적 tie-break 후, utterance 당 first row = 최신.
  // 단일 labeler 운영(설계 §10): 다중 labeler IAA/합의는 미도입 — 지금은 "최신 행" 채택.
  // 실패 시 graceful: human_label 전부 null 로, 목록 응답은 막지 않음.
  const humanLabelByUtt = new Map<string, {
    fine_label: string | null
    emotion_category: string | null
    category_decision: string | null
    category_source: string | null
    updated_at: string | null
  }>()
  const uttIds = rows.map((r) => r.id as string).filter(Boolean)
  if (uttIds.length > 0) {
    const { data: hlRows, error: hlError } = await supabaseAdmin
      .from('utterance_human_labels')
      .select('utterance_id, fine_label, emotion_category, category_decision, category_source, updated_at')
      .in('utterance_id', uttIds)
      .eq('label_type', 'emotion')
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      // PostgREST 기본 1000행 클립 방지 — 목록 cap(5000)에 맞춤.
      // 단일 labeler + UNIQUE(utterance_id,label_type,labeler_id)라 라벨된 utterance당 1행이므로 충분.
      .limit(5000)
    if (hlError) {
      console.error('[admin-utterances-v2] human_label query error:', hlError.message)
    } else {
      for (const hl of (hlRows ?? []) as Array<Record<string, unknown>>) {
        const uid = hl.utterance_id as string
        if (!uid || humanLabelByUtt.has(uid)) continue  // first = 최신
        humanLabelByUtt.set(uid, {
          fine_label: (hl.fine_label as string) ?? null,
          emotion_category: (hl.emotion_category as string) ?? null,
          category_decision: (hl.category_decision as string) ?? null,
          category_source: (hl.category_source as string) ?? null,
          updated_at: (hl.updated_at as string) ?? null,
        })
      }
    }
  }

  const utterances = rows.map((row) => {
    const startMs = (row.start_ms as number) ?? 0
    const endMs = (row.end_ms as number) ?? 0
    const storedDur = row.duration_seconds as number | null
    const durSec = storedDur ?? Math.max(0, (endMs - startMs) / 1000)
    const storedPrice = row.unit_price_krw as number | null
    const computedPrice = Math.round((durSec * HOURLY_RATE_KRW) / 3600)
    const sess = row.sessions as
      | { session_seq?: number | null; date?: string | null; duration?: number | null; review_status?: string | null; consent_status?: string | null }
      | null
    const spk = row.session_speakers as
      | { speaker_role?: string | null; speaker_gender?: string | null }
      | null
    const seg = row.session_segments as { topic?: string | null } | null
    // STAGE 6 — raw title 응답 금지. 합성 display_title 만 반환.
    const displayTitle = formatDisplayTitle(sess?.session_seq ?? null, sess?.date ?? null, sess?.duration ?? null)
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      session_title: displayTitle,
      session_duration_sec: sess?.duration ?? null,
      session_review_status: (sess?.review_status as string) ?? 'pending',
      session_consent_status: (sess?.consent_status as string) ?? null,
      speaker_id: (row.speaker_id as string) ?? null,
      session_speaker_id: (row.session_speaker_id as string) ?? null,
      speaker_role: spk?.speaker_role ?? null,
      speaker_gender: spk?.speaker_gender ?? null,
      segment_id: (row.segment_id as string) ?? null,
      segment_topic: seg?.topic ?? null,
      start_ms: startMs,
      end_ms: endMs,
      duration_seconds: durSec,
      // Track 0 응급 PII — 알려진 실명(PII_NAME_DENYLIST) 표시-시점 마스킹.
      // DB 미변형(비파괴). env 미설정 시 no-op.
      text: maskKnownNames(((row.transcript_text as string) ?? '').slice(0, 200)),
      unit_price_krw: storedPrice ?? computedPrice,
      settled_at: (row.settled_at as string) ?? null,
      review_status: ((row.review_status as string) ?? 'pending') as 'pending' | 'excluded',
      exclude_reason: (row.exclude_reason as string) ?? null,
      reviewed_at: (row.reviewed_at as string) ?? null,
      // 납품 품질 검수 (migration 077) — 새로고침 후 배지 유지용. review_status 와 직교.
      quality_grade: (row.quality_grade as string) ?? null,
      quality_review_status: (row.quality_review_status as string) ?? null,
      quality_exclusion_reason: (row.quality_exclusion_reason as string) ?? null,
      // 자동라벨 (표시 전용 — 발화 단위 라벨 검수)
      emotion: (row.emotion as string) ?? null,
      emotion_confidence: (row.emotion_confidence as number) ?? null,
      dialog_act: (row.dialog_act as string) ?? null,
      dialog_act_confidence: (row.dialog_act_confidence as number) ?? null,
      label_source: (row.label_source as string) ?? null,
      auto_label_model_version: (row.auto_label_model_version as string) ?? null,
      utterance_form:
        row.utterance_form && typeof row.utterance_form === 'object' && !Array.isArray(row.utterance_form)
          ? (row.utterance_form as Record<string, unknown>)
          : null,
      honorific_level: (row.honorific_level as string) ?? null,
      confidence_tier: (row.confidence_tier as string) ?? null,
      // T2 검수 소프트플래그 (호격/Nim-Guard 등). 마스킹 아님 — 사람 검수 대기 신호.
      review_flags: Array.isArray(row.review_flags) ? (row.review_flags as Record<string, unknown>[]) : null,
      review_priority_score: (row.review_priority_score as number) ?? null,
      // H2b — 사람 emotion 라벨 (최신 1행). 없으면 null. labeler 식별자는 응답에서 제외.
      human_label: humanLabelByUtt.get(row.id as string) ?? null,
    }
  })

  return c.json({
    data: {
      utterances,
      total: count ?? 0,
      page,
      limit,
      constants: { hourlyRateKrw: HOURLY_RATE_KRW },
    },
  })
})

adminUtterancesV2.get('/utterances-v2/stats', async (c) => {
  // deliveries 테이블에서 납품된 session_id 목록 조회
  const { data: deliveryRows } = await supabaseAdmin
    .from('deliveries')
    .select('session_id')
  const deliveredSessionIds = [...new Set((deliveryRows ?? []).map((r: { session_id: string }) => r.session_id))]

  // 납품된 세션의 발화 수 집계 (청크 100개씩)
  let deliveredCount = 0
  if (deliveredSessionIds.length > 0) {
    const CHUNK = 100
    for (let i = 0; i < deliveredSessionIds.length; i += CHUNK) {
      const chunk = deliveredSessionIds.slice(i, i + CHUNK)
      const { count } = await supabaseAdmin
        .from('utterances')
        .select('id', { count: 'exact', head: true })
        .in('session_id', chunk)
      deliveredCount += count ?? 0
    }
  }

  const [totalRes, settledRes, unsettledRes] = await Promise.all([
    supabaseAdmin.from('utterances').select('id', { count: 'exact', head: true }),
    supabaseAdmin
      .from('utterances')
      .select('id', { count: 'exact', head: true })
      .not('settled_at', 'is', null),
    supabaseAdmin
      .from('utterances')
      .select('id', { count: 'exact', head: true })
      .is('settled_at', null),
  ])

  // 시간 합산 — duration_seconds 우선, 없으면 (end_ms-start_ms)/1000
  // Supabase 기본 row limit 1000 회피: 1000건씩 페이지 누적
  let totalDurationSec = 0
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data: durRows, error } = await supabaseAdmin
      .from('utterances')
      .select('duration_seconds, start_ms, end_ms')
      .range(offset, offset + PAGE - 1)
    if (error) return c.json({ error: error.message }, 500)
    const rows = (durRows ?? []) as Array<Record<string, unknown>>
    for (const row of rows) {
      const stored = row.duration_seconds as number | null
      if (stored != null) {
        totalDurationSec += stored
      } else {
        const startMs = (row.start_ms as number) ?? 0
        const endMs = (row.end_ms as number) ?? 0
        totalDurationSec += Math.max(0, (endMs - startMs) / 1000)
      }
    }
    if (rows.length < PAGE) break  // 마지막 페이지
    offset += PAGE
    if (offset > 100_000) break  // 안전 가드 (10만건 초과 방어)
  }

  return c.json({
    data: {
      total: totalRes.count ?? 0,
      settledCount: settledRes.count ?? 0,
      unsettledCount: unsettledRes.count ?? 0,
      deliveredCount,
      totalDurationSec,
      estimatedRevenueKrw: Math.round((totalDurationSec * HOURLY_RATE_KRW) / 3600),
    },
  })
})

// ── PATCH /utterances-v2/:id — DEPRECATED (PR-H2c, 410 Gone) ────────────
// utterances 의 모델 라벨(emotion/dialog_act/label_source) 어드민 인플레이스 편집 경로를 폐기한다.
// 모델 emotion/dialog_act 는 자동라벨(voice-api worker) 산출값으로 고정 — 어드민이 덮어쓰지 않는다.
// 사람 검수 결과는 별도 테이블 utterance_human_labels 로만 적재한다(POST /utterances/:id/human-label).
//
// body 무관 410 반환(엔드포인트 전체 deprecate). DB 에 접근하지 않으므로 utterances.emotion 불변이 보장된다.
// 설계: scripts/analysis/design_h2c_block_inplace_emotion_patch_20260526.md (완전 차단 · 410 · admin-first).
adminUtterancesV2.patch('/utterances-v2/:id', (c) => {
  return c.json(
    {
      error:
        'utterances 모델 라벨(emotion/dialog_act)의 인플레이스 수정은 폐기되었습니다. 사람 감정 라벨은 별도 경로로 저장하세요.',
      use: 'POST /api/admin/utterances/:id/human-label',
    },
    410,
  )
})

// ── GET /utterances-v2/:id/audio ────────────────────────────────────────
// 발화 WAV presigned URL 반환 (TTL 60초, 검수 재생용)

adminUtterancesV2.get('/utterances-v2/:id/audio', async (c) => {
  const id = c.req.param('id')

  const { data, error } = await supabaseAdmin
    .from('utterances')
    .select('storage_path')
    .eq('id', id)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return c.json({ error: '발화를 찾을 수 없습니다.' }, 404)
    return c.json({ error: error.message }, 500)
  }

  const row = data as { storage_path: string | null }
  if (!row.storage_path) return c.json({ error: '오디오 파일이 없습니다.' }, 404)

  const url = await getSignedUrl(S3_AUDIO_BUCKET, row.storage_path, 60)
  return c.json({ data: { url } })
})

export default adminUtterancesV2
