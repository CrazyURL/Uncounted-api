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
      'id, session_id, speaker_id, start_ms, end_ms, transcript_text, duration_seconds, unit_price_krw, settled_at, review_status, exclude_reason, reviewed_at, sessions(session_seq, date, duration, review_status, consent_status)',
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
      start_ms: startMs,
      end_ms: endMs,
      duration_seconds: durSec,
      text: ((row.transcript_text as string) ?? '').slice(0, 200),
      unit_price_krw: storedPrice ?? computedPrice,
      settled_at: (row.settled_at as string) ?? null,
      review_status: ((row.review_status as string) ?? 'pending') as 'pending' | 'excluded',
      exclude_reason: (row.exclude_reason as string) ?? null,
      reviewed_at: (row.reviewed_at as string) ?? null,
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
      totalDurationSec,
      estimatedRevenueKrw: Math.round((totalDurationSec * HOURLY_RATE_KRW) / 3600),
    },
  })
})

// ── PATCH /utterances-v2/:id ────────────────────────────────────────────
// 어드민 감정/대화행위 라벨 수정 (STAGE 14 검수 UI)

adminUtterancesV2.patch('/utterances-v2/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    emotion?: string
    dialog_act?: string
    label_source?: string
  }>().catch(() => ({} as { emotion?: string; dialog_act?: string; label_source?: string }))

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.emotion !== undefined) update.emotion = body.emotion
  if (body.dialog_act !== undefined) update.dialog_act = body.dialog_act
  if (body.label_source !== undefined) update.label_source = body.label_source

  const { data, error } = await supabaseAdmin
    .from('utterances')
    .update(update)
    .eq('id', id)
    .select('id, emotion, dialog_act, label_source, updated_at')
    .single()

  if (error) {
    if (error.code === 'PGRST116') return c.json({ error: '발화를 찾을 수 없습니다.' }, 404)
    return c.json({ error: error.message }, 500)
  }

  return c.json({ data })
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
