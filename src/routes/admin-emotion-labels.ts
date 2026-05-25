// ── Admin Emotion Human Label API (PR-H1a 읽기 골격 + PR-H2a-api 저장) ──────
// utterance_human_labels(사람/자동파생 emotion 라벨)의 검수 큐 조회 + 진행도 stats + 사람 라벨 저장.
// 설계: scripts/analysis/design_human_emotion_label_loop_20260524.md
//
// 라우트:
//   GET  /api/admin/emotion-labels/queue        — 검수 큐(저신뢰 utterances + human pending/undecidable)
//   GET  /api/admin/emotion-labels/stats        — 진행도 집계 + 학습 게이트(§11)
//   POST /api/admin/utterances/:id/human-label  — 사람 emotion 라벨 저장(upsert) [PR-H2a-api]
//
// 불변식: utterances.emotion(모델 출력)은 절대 수정하지 않는다. 사람 라벨은 utterance_human_labels 에만.
// 안전 계약: 발화 원문은 기존 admin utterance 정책과 동일하게 maskKnownNames + 200자 슬라이스.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import { maskKnownNames } from '../lib/piiNameMask.js'
import {
  LOW_CONFIDENCE_THRESHOLD,
  summarizeHumanLabelStats,
  computeEmotionGate,
  buildHumanLabelUpsert,
  type HumanLabelStatsRow,
  type HumanLabelInput,
} from '../lib/emotion/humanLabelReview.js'

const adminEmotionLabels = new Hono()

adminEmotionLabels.use('/emotion-labels/*', authMiddleware)
adminEmotionLabels.use('/emotion-labels/*', adminMiddleware)
adminEmotionLabels.use('/utterances/:id/human-label', authMiddleware)
adminEmotionLabels.use('/utterances/:id/human-label', adminMiddleware)

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SCAN_CAP = 50_000 // stats 전수 집계 안전 가드

function maskText(raw: unknown): string {
  return maskKnownNames(((raw as string) ?? '').slice(0, 200))
}

// ── GET /api/admin/emotion-labels/queue ─────────────────────────────────
// ?source=low_confidence(기본) | human_pending, ?limit, ?offset, ?threshold
adminEmotionLabels.get('/emotion-labels/queue', async (c) => {
  const url = new URL(c.req.url)
  const source = url.searchParams.get('source') ?? 'low_confidence'
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit') ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  )
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
  const thRaw = Number(url.searchParams.get('threshold'))
  const threshold = Number.isFinite(thRaw) && thRaw > 0 && thRaw <= 1 ? thRaw : LOW_CONFIDENCE_THRESHOLD

  if (source !== 'low_confidence' && source !== 'human_pending') {
    return c.json({ error: 'invalid source (low_confidence|human_pending)' }, 400)
  }

  if (source === 'human_pending') {
    // 검수 큐로 명시된 human 라벨(놀람/당황 보류 + 판단불가).
    const { data, error, count } = await supabaseAdmin
      .from('utterance_human_labels')
      .select(
        'id, utterance_id, session_id, fine_label, emotion_category, category_decision, label_confidence, updated_at',
        { count: 'exact' },
      )
      .in('category_decision', ['pending_context', 'undecidable'])
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (error) return c.json({ error: error.message }, 500)

    const rows = (data ?? []) as Array<Record<string, unknown>>
    const texts = await fetchTexts(rows.map((r) => r.utterance_id as string))
    const items = rows.map((r) => ({
      utterance_id: r.utterance_id as string,
      session_id: r.session_id as string,
      text: maskText(texts.get(r.utterance_id as string)),
      human_fine_label: (r.fine_label as string) ?? null,
      human_emotion_category: (r.emotion_category as string) ?? null,
      category_decision: r.category_decision as string,
      queue_reason: r.category_decision as string,
    }))
    return c.json({ success: true, data: items, meta: { source, total: count ?? items.length, limit, offset, threshold } })
  }

  // source === 'low_confidence': 모델 저신뢰(emotion_confidence null 또는 < threshold) 발화.
  // 이미 resolved human 라벨이 있는 발화는 제외(app-side; H1a 에서는 대개 0건).
  const resolvedIds = await fetchResolvedUtteranceIds()

  const { data, error, count } = await supabaseAdmin
    .from('utterances')
    .select('id, session_id, transcript_text, emotion, emotion_confidence', { count: 'exact' })
    .or(`emotion_confidence.is.null,emotion_confidence.lt.${threshold}`)
    .order('session_id', { ascending: false })
    .order('start_ms', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) return c.json({ error: error.message }, 500)

  const items = ((data ?? []) as Array<Record<string, unknown>>)
    .filter((r) => !resolvedIds.has(r.id as string))
    .map((r) => ({
      utterance_id: r.id as string,
      session_id: (r.session_id as string) ?? null,
      text: maskText(r.transcript_text),
      model_emotion: (r.emotion as string) ?? null,
      model_emotion_confidence: (r.emotion_confidence as number) ?? null,
      queue_reason: 'low_confidence' as const,
    }))

  return c.json({
    success: true,
    data: items,
    meta: { source, total: count ?? items.length, limit, offset, threshold },
  })
})

// ── GET /api/admin/emotion-labels/stats ─────────────────────────────────
// 진행도 집계(§11.1) + 학습 게이트(§11.2). utterances.emotion(모델)은 포함하지 않는다.
adminEmotionLabels.get('/emotion-labels/stats', async (c) => {
  const rows: HumanLabelStatsRow[] = []
  const PAGE = 1000
  let offset = 0
  // 전수 집계(페이지 누적). 분포는 supabase-js GROUP BY 미지원 → app-side 집계.
  while (offset < SCAN_CAP) {
    const { data, error } = await supabaseAdmin
      .from('utterance_human_labels')
      .select('category_decision, category_source, emotion_category, fine_label')
      .eq('label_type', 'emotion')
      .range(offset, offset + PAGE - 1)
    if (error) return c.json({ error: error.message }, 500)
    const page = (data ?? []) as HumanLabelStatsRow[]
    rows.push(...page)
    if (page.length < PAGE) break
    offset += PAGE
  }

  // 저신뢰 큐 카운트(아직 human 라벨이 없는 모델 저신뢰 발화 수).
  const { count: lowConfCount } = await supabaseAdmin
    .from('utterances')
    .select('id', { count: 'exact', head: true })
    .or(`emotion_confidence.is.null,emotion_confidence.lt.${LOW_CONFIDENCE_THRESHOLD}`)

  const stats = summarizeHumanLabelStats(rows)
  const gate = computeEmotionGate(stats)

  return c.json({
    success: true,
    data: {
      ...stats,
      lowConfidenceQueueCount: lowConfCount ?? 0,
      gate: gate.gate,
      nextRequired: gate.nextRequired,
      threshold: LOW_CONFIDENCE_THRESHOLD,
    },
  })
})

// ── helpers ─────────────────────────────────────────────────────────────
async function fetchResolvedUtteranceIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  const { data } = await supabaseAdmin
    .from('utterance_human_labels')
    .select('utterance_id')
    .eq('category_decision', 'resolved')
    .limit(SCAN_CAP)
  for (const r of (data ?? []) as Array<{ utterance_id: string }>) ids.add(r.utterance_id)
  return ids
}

async function fetchTexts(utteranceIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  if (utteranceIds.length === 0) return map
  const { data } = await supabaseAdmin
    .from('utterances')
    .select('id, transcript_text')
    .in('id', utteranceIds)
  for (const r of (data ?? []) as Array<{ id: string; transcript_text: string | null }>) {
    map.set(r.id, r.transcript_text)
  }
  return map
}

// ── POST /api/admin/utterances/:id/human-label (PR-H2a-api) ──────────────
// body: { fine_label?, emotion_category?, category_decision, label_confidence?, note? }
//   - category_source 는 서버가 강제(resolved⇒manual / 그 외⇒null) — 클라이언트 미신뢰.
//   - session_id 는 utterance 에서 서버측 도출. labeler_id = auth uid, labeler_email = 조회.
//   - utterances.emotion 은 절대 수정하지 않는다. utterance_human_labels 만 upsert.
adminEmotionLabels.post('/utterances/:id/human-label', async (c) => {
  const utteranceId = c.req.param('id')
  const body = getBody<HumanLabelInput>(c) ?? {}

  // 발화 존재 확인 + session_id 서버측 도출(클라이언트 미신뢰).
  const { data: utt, error: uttErr } = await supabaseAdmin
    .from('utterances')
    .select('id, session_id')
    .eq('id', utteranceId)
    .single()
  if (uttErr || !utt) return c.json({ error: '발화를 찾을 수 없습니다.' }, 404)
  const utterance = utt as { id: string; session_id: string }

  const labelerId = c.get('userId') as string
  let labelerEmail: string | null = null
  try {
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(labelerId)
    labelerEmail = u?.user?.email ?? null
  } catch {
    labelerEmail = null
  }

  const built = buildHumanLabelUpsert(
    body,
    { utteranceId: utterance.id, sessionId: utterance.session_id, labelerId, labelerEmail },
    new Date().toISOString(),
  )
  if ('error' in built) return c.json({ error: built.error }, 400)

  // 검수자 1인당 발화·타입당 1행. 재저장 시 갱신(upsert).
  const { data, error } = await supabaseAdmin
    .from('utterance_human_labels')
    .upsert(built.row, { onConflict: 'utterance_id,label_type,labeler_id' })
    .select(
      'id, utterance_id, session_id, label_type, fine_label, emotion_category, category_decision, category_source, label_confidence, note, labeler_id, created_at, updated_at',
    )
    .single()
  if (error) return c.json({ error: error.message }, 500)

  return c.json({ success: true, data }, 200)
})

export default adminEmotionLabels
