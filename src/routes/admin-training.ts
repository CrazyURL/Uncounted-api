// ── Admin Training API (STAGE 14: 자동라벨링 성장형 모델) ──────────────
// GPU 서버 KcELECTRA 재학습 트리거 + 학습 통계/익스포트 엔드포인트
//
// 라우트:
//   GET  /api/admin/training/stats           — 확인된 레이블 통계
//   GET  /api/admin/training/export          — 학습 데이터 CSV 다운로드
//   POST /api/admin/training/trigger         — 재학습 시작 (Voice API 프록시)
//   GET  /api/admin/training/status/:jobId  — 학습 진행 상태 (Voice API 프록시)

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware } from '../lib/middleware.js'

const VOICE_API_URL = process.env.VOICE_API_URL ?? 'http://localhost:8001'
const MIN_THRESHOLD_INITIAL = 500

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
