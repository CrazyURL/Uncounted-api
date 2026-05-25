// ── Admin Training API (STAGE 14: 자동라벨링 성장형 모델) ──────────────
// GPU 서버 KcELECTRA 재학습 트리거 + 학습 통계/익스포트 엔드포인트
//
// 라우트:
//   GET  /api/admin/training/stats           — 확인된 레이블 통계
//   GET  /api/admin/training/export          — 학습 데이터 CSV 다운로드
//   POST /api/admin/training/trigger         — 재학습 시작 (Voice API 프록시)
//   GET  /api/admin/training/status/:jobId  — 학습 진행 상태 (Voice API 프록시)
//   GET  /api/admin/training/pii-progress    — PII 학습 데이터 진행도 + 게이트 (read-only, PR-P2E)

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware } from '../lib/middleware.js'
import { mapPredictedToAnnotationType } from '../lib/pii/annotationReview.js'

const VOICE_API_URL = process.env.VOICE_API_URL ?? 'http://localhost:8001'
const MIN_THRESHOLD_INITIAL = 500

// ── PII 학습 연동 게이트 (PR-P2D export 스크립트와 동일 임계) ───────────
// Gate3 미만은 학습 투입 금지. 본 엔드포인트는 read-only 진행도/게이트만 반환.
interface PiiGate {
  id: number
  name: string
  pos: number
  neg: number
  learning: boolean
}
const PII_GATES: readonly PiiGate[] = [
  { id: 1, name: 'Gate 1: smoke export only', pos: 0, neg: 0, learning: false },
  { id: 2, name: 'Gate 2: 검수 루프 검증', pos: 10, neg: 10, learning: false },
  { id: 3, name: 'Gate 3: 학습 파일럿', pos: 50, neg: 50, learning: true },
  { id: 4, name: 'Gate 4: detector 개선 실험', pos: 200, neg: 200, learning: true },
  { id: 5, name: 'Gate 5: 정기 학습 후보', pos: 500, neg: 500, learning: true },
]

const adminTraining = new Hono()

adminTraining.use('/*', authMiddleware)
adminTraining.use('/*', adminMiddleware)

// ── GET /training/stats ─────────────────────────────────────────────────

adminTraining.get('/training/stats', async (c) => {
  const [autoConfirmedRes, adminConfirmedRes, emotionDistRes] = await Promise.all([
    supabaseAdmin
      .from('utterances')
      .select('id', { count: 'exact', head: true })
      .eq('label_source', 'auto_confirmed')
      .not('emotion', 'is', null),
    supabaseAdmin
      .from('utterances')
      .select('id', { count: 'exact', head: true })
      .eq('label_source', 'admin_confirmed')
      .not('emotion', 'is', null),
    supabaseAdmin
      .from('utterances')
      .select('emotion')
      .in('label_source', ['auto_confirmed', 'admin_confirmed'])
      .not('emotion', 'is', null),
  ])

  if (autoConfirmedRes.error) return c.json({ error: autoConfirmedRes.error.message }, 500)
  if (adminConfirmedRes.error) return c.json({ error: adminConfirmedRes.error.message }, 500)
  if (emotionDistRes.error) return c.json({ error: emotionDistRes.error.message }, 500)

  const autoCount = autoConfirmedRes.count ?? 0
  const adminCount = adminConfirmedRes.count ?? 0
  const totalConfirmed = autoCount + adminCount

  // 감정 분포 집계
  const emotionDist: Record<string, number> = { 긍정: 0, 중립: 0, 부정: 0 }
  for (const row of emotionDistRes.data ?? []) {
    const e = (row as { emotion: string }).emotion
    if (e in emotionDist) emotionDist[e]++
  }

  const needsMoreCount = Math.max(0, MIN_THRESHOLD_INITIAL - totalConfirmed)

  return c.json({
    data: {
      totalConfirmed,
      autoConfirmedCount: autoCount,
      adminConfirmedCount: adminCount,
      emotionDistribution: emotionDist,
      minThreshold: MIN_THRESHOLD_INITIAL,
      needsMoreCount,
      canTrigger: totalConfirmed >= MIN_THRESHOLD_INITIAL,
      lastRetrainAt: null,
    },
  })
})

// ── GET /training/pii-progress (read-only, PR-P2E) ──────────────────────
// PII 검수 라벨이 학습 데이터로 얼마나 쌓였는지 + 다음 게이트까지 부족분. count/type/gate 만.
// 원문(matched_text/snippet/transcript_text) 미반환. PR-P2D export 와 동일 정의.
adminTraining.get('/training/pii-progress', async (c) => {
  const POS = supabaseAdmin
    .from('pii_annotations')
    .select('id', { count: 'exact', head: true })
    .in('source', ['detector_candidate', 'admin_manual'])
    .in('action_status', ['pending_mask', 'masked'])
  const NEG = supabaseAdmin
    .from('pii_candidates')
    .select('id', { count: 'exact', head: true })
    .eq('admin_decision', 'rejected')
    .eq('status', 'decided')
  const SKIP = supabaseAdmin
    .from('pii_candidates')
    .select('id', { count: 'exact', head: true })
    .eq('admin_decision', 'skipped')
  const PEND = supabaseAdmin
    .from('pii_candidates')
    .select('id', { count: 'exact', head: true })
    .eq('confidence_tier', 'needs_human_decision')
    .eq('status', 'pending')
  const POS_TYPES = supabaseAdmin
    .from('pii_annotations')
    .select('pii_type')
    .in('source', ['detector_candidate', 'admin_manual'])
    .in('action_status', ['pending_mask', 'masked'])
  const NEG_TYPES = supabaseAdmin
    .from('pii_candidates')
    .select('predicted_type')
    .eq('admin_decision', 'rejected')
    .eq('status', 'decided')

  const [posR, negR, skipR, pendR, posTR, negTR] = await Promise.all([POS, NEG, SKIP, PEND, POS_TYPES, NEG_TYPES])
  for (const r of [posR, negR, skipR, pendR, posTR, negTR]) {
    if (r.error) return c.json({ error: r.error.message }, 500)
  }

  const positive = posR.count ?? 0
  const negative = negR.count ?? 0

  const byTypePositive: Record<string, number> = {}
  for (const row of (posTR.data ?? []) as Array<{ pii_type: string | null }>) {
    const k = row.pii_type ?? 'unknown'
    byTypePositive[k] = (byTypePositive[k] ?? 0) + 1
  }
  // negative 는 predicted_type(한글) → annotation enum 으로 매핑해 positive 와 타입공간 일치.
  const byTypeNegative: Record<string, number> = {}
  for (const row of (negTR.data ?? []) as Array<{ predicted_type: string | null }>) {
    const k = mapPredictedToAnnotationType(row.predicted_type) ?? row.predicted_type ?? 'unknown'
    byTypeNegative[k] = (byTypeNegative[k] ?? 0) + 1
  }

  let current = PII_GATES[0]
  for (const g of PII_GATES) if (positive >= g.pos && negative >= g.neg) current = g
  const pilot = PII_GATES.find((g) => g.id === 3)!
  const next = PII_GATES.find((g) => g.id === current.id + 1) ?? null

  return c.json({
    data: {
      positive_annotations: positive,
      negative_candidates: negative,
      skipped_candidates: skipR.count ?? 0,
      pending_review: pendR.count ?? 0,
      by_type_positive: byTypePositive,
      by_type_negative: byTypeNegative,
      gate: {
        current: current.name,
        learning_eligible: current.learning,
        pilot_required_positive: pilot.pos,
        pilot_required_negative: pilot.neg,
        positive_remaining: Math.max(0, pilot.pos - positive),
        negative_remaining: Math.max(0, pilot.neg - negative),
        next: next ? next.name : null,
      },
    },
  })
})

// ── GET /training/export ────────────────────────────────────────────────

adminTraining.get('/training/export', async (c) => {
  // 최대 1000건 (OOM 방지 — 대량 익스포트는 cursor 페이지네이션으로 구현 필요)
  const { data, error } = await supabaseAdmin
    .from('utterances')
    .select('id, transcript_text, emotion, dialog_act, label_source, emotion_confidence')
    .in('label_source', ['auto_confirmed', 'admin_confirmed'])
    .not('emotion', 'is', null)
    .not('dialog_act', 'is', null)
    .not('transcript_text', 'is', null)
    .limit(1000)

  if (error) return c.json({ error: error.message }, 500)

  const rows = (data ?? []) as Array<Record<string, unknown>>
  const lines = ['id\ttext\temotion\tdialog_act\tlabel_source\temotion_confidence']
  for (const row of rows) {
    const text = ((row.transcript_text as string) ?? '').replace(/\t/g, ' ').replace(/\n/g, ' ')
    lines.push(
      [
        row.id,
        text,
        row.emotion,
        row.dialog_act,
        row.label_source,
        row.emotion_confidence ?? '',
      ].join('\t'),
    )
  }

  const csv = lines.join('\n')
  const filename = `training_data_${new Date().toISOString().slice(0, 10)}.tsv`

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/tab-separated-values; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})

// ── POST /training/trigger ──────────────────────────────────────────────

adminTraining.post('/training/trigger', async (c) => {
  // 임계값 체크
  const { count: autoCount, error: e1 } = await supabaseAdmin
    .from('utterances')
    .select('id', { count: 'exact', head: true })
    .in('label_source', ['auto_confirmed', 'admin_confirmed'])
    .not('emotion', 'is', null)

  if (e1) return c.json({ error: e1.message }, 500)

  const total = autoCount ?? 0
  if (total < MIN_THRESHOLD_INITIAL) {
    return c.json(
      {
        error: `학습 데이터 부족: ${total}건 / 최소 ${MIN_THRESHOLD_INITIAL}건 필요 (${MIN_THRESHOLD_INITIAL - total}건 더 필요)`,
        totalConfirmed: total,
        minThreshold: MIN_THRESHOLD_INITIAL,
      },
      400,
    )
  }

  let voiceRes: Response
  try {
    voiceRes = await fetch(`${VOICE_API_URL}/api/v1/training/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggered_by: 'admin' }),
    })
  } catch (err) {
    return c.json({ error: `Voice API 연결 실패: ${String(err)}` }, 502)
  }

  if (!voiceRes.ok) {
    const body = await voiceRes.text().catch(() => '')
    return c.json({ error: `Voice API 오류 (${voiceRes.status}): ${body}` }, 502)
  }

  const result = (await voiceRes.json()) as { job_id?: string }
  return c.json({ data: { jobId: result.job_id, totalConfirmed: total } })
})

// ── GET /training/status/:jobId ─────────────────────────────────────────

adminTraining.get('/training/status/:jobId', async (c) => {
  const jobId = c.req.param('jobId')

  let voiceRes: Response
  try {
    voiceRes = await fetch(`${VOICE_API_URL}/api/v1/training/status/${jobId}`)
  } catch (err) {
    return c.json({ error: `Voice API 연결 실패: ${String(err)}` }, 502)
  }

  if (!voiceRes.ok) {
    const body = await voiceRes.text().catch(() => '')
    return c.json({ error: `Voice API 오류 (${voiceRes.status}): ${body}` }, 502)
  }

  const result = await voiceRes.json()
  return c.json({ data: result })
})

export default adminTraining
