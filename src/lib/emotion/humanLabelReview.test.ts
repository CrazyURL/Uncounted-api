// ── Human Emotion Label 순수 로직 단위 테스트 (PR-H1a) ──────────────────────
import { describe, it, expect } from 'vitest'

import {
  deriveEmotionCategory,
  validateHumanLabelRow,
  isLowConfidence,
  summarizeHumanLabelStats,
  computeEmotionGate,
  LOW_CONFIDENCE_THRESHOLD,
  type HumanLabelStatsRow,
} from './humanLabelReview.js'

describe('deriveEmotionCategory (안전맵)', () => {
  it('기쁨 → 긍정 resolved/derived', () => {
    expect(deriveEmotionCategory('기쁨')).toEqual({
      emotionCategory: '긍정',
      categoryDecision: 'resolved',
      categorySource: 'derived',
    })
  })
  it('중립 → 중립 resolved/derived', () => {
    expect(deriveEmotionCategory('중립').emotionCategory).toBe('중립')
  })
  it('슬픔/분노/불안 → 부정 resolved/derived', () => {
    for (const f of ['슬픔', '분노', '불안']) {
      const r = deriveEmotionCategory(f)
      expect(r.emotionCategory).toBe('부정')
      expect(r.categoryDecision).toBe('resolved')
      expect(r.categorySource).toBe('derived')
    }
  })
  it('놀람/당황 → pending_context (category·source null, 무조건 부정 금지)', () => {
    for (const f of ['놀람', '당황']) {
      expect(deriveEmotionCategory(f)).toEqual({
        emotionCategory: null,
        categoryDecision: 'pending_context',
        categorySource: null,
      })
    }
  })
  it('알 수 없는 라벨 → pending_context (강제 분류 금지, undecidable 아님)', () => {
    const r = deriveEmotionCategory('황당함')
    expect(r.categoryDecision).toBe('pending_context')
    expect(r.emotionCategory).toBeNull()
  })
})

describe('validateHumanLabelRow (DB CHECK 미러)', () => {
  it('resolved + fine + category + source: 유효', () => {
    expect(
      validateHumanLabelRow({
        fine_label: '기쁨',
        emotion_category: '긍정',
        category_decision: 'resolved',
        category_source: 'derived',
      }),
    ).toBeNull()
  })
  it('resolved 인데 emotion_category null: 위반', () => {
    expect(
      validateHumanLabelRow({
        fine_label: '기쁨',
        emotion_category: null,
        category_decision: 'resolved',
        category_source: 'manual',
      }),
    ).toMatch(/resolved requires fine_label and emotion_category/)
  })
  it('resolved 인데 category_source null: 위반', () => {
    expect(
      validateHumanLabelRow({
        fine_label: '기쁨',
        emotion_category: '긍정',
        category_decision: 'resolved',
        category_source: null,
      }),
    ).toMatch(/resolved requires category_source/)
  })
  it('undecidable + fine_label null: 유효 (억지 중립 금지)', () => {
    expect(
      validateHumanLabelRow({
        fine_label: null,
        emotion_category: null,
        category_decision: 'undecidable',
        category_source: null,
      }),
    ).toBeNull()
  })
  it('pending_context + fine 있고 category null: 유효', () => {
    expect(
      validateHumanLabelRow({
        fine_label: '놀람',
        emotion_category: null,
        category_decision: 'pending_context',
        category_source: null,
      }),
    ).toBeNull()
  })
  it('잘못된 decision/fine/category enum: 위반', () => {
    expect(
      validateHumanLabelRow({ fine_label: '기쁨', emotion_category: '긍정', category_decision: 'bogus', category_source: 'derived' }),
    ).toMatch(/invalid category_decision/)
    expect(
      validateHumanLabelRow({ fine_label: '졸림', emotion_category: null, category_decision: 'pending_context', category_source: null }),
    ).toMatch(/invalid fine_label/)
    expect(
      validateHumanLabelRow({ fine_label: '기쁨', emotion_category: '아주좋음', category_decision: 'resolved', category_source: 'manual' }),
    ).toMatch(/invalid emotion_category/)
  })
})

describe('isLowConfidence', () => {
  it('null/undefined/NaN → 불확실 = true', () => {
    expect(isLowConfidence(null)).toBe(true)
    expect(isLowConfidence(undefined)).toBe(true)
    expect(isLowConfidence(NaN)).toBe(true)
  })
  it('임계 미만 → true, 이상 → false', () => {
    expect(isLowConfidence(LOW_CONFIDENCE_THRESHOLD - 0.01)).toBe(true)
    expect(isLowConfidence(LOW_CONFIDENCE_THRESHOLD)).toBe(false)
    expect(isLowConfidence(0.95)).toBe(false)
  })
})

describe('summarizeHumanLabelStats', () => {
  const rows: HumanLabelStatsRow[] = [
    { category_decision: 'resolved', category_source: 'derived', emotion_category: '긍정', fine_label: '기쁨' },
    { category_decision: 'resolved', category_source: 'manual', emotion_category: '부정', fine_label: '슬픔' },
    { category_decision: 'resolved', category_source: 'manual', emotion_category: '중립', fine_label: '놀람' },
    { category_decision: 'pending_context', category_source: null, emotion_category: null, fine_label: '당황' },
    { category_decision: 'undecidable', category_source: null, emotion_category: null, fine_label: null },
  ]
  it('decision/source/category/fine 카운트 정확', () => {
    const s = summarizeHumanLabelStats(rows)
    expect(s.resolvedTotal).toBe(3)
    expect(s.resolvedManual).toBe(2)
    expect(s.resolvedDerived).toBe(1)
    expect(s.pendingContext).toBe(1)
    expect(s.undecidable).toBe(1)
    expect(s.byCategory).toEqual({ 긍정: 1, 중립: 1, 부정: 1 })
    // byCategoryManual: manual(gold) 행만 — 긍정(기쁨)은 derived 라 제외, 중립·부정만 manual.
    expect(s.byCategoryManual).toEqual({ 긍정: 0, 중립: 1, 부정: 1 })
    expect(s.byFineLabel.당황).toBe(1)
    expect(s.byFineLabel.놀람).toBe(1)
  })
  it('utterances.emotion(모델)은 미포함 — undecidable 행의 null fine 은 fine 카운트 0', () => {
    const s = summarizeHumanLabelStats(rows)
    const fineTotal = Object.values(s.byFineLabel).reduce((a, b) => a + b, 0)
    expect(fineTotal).toBe(4) // null fine 1건 제외
  })
})

describe('computeEmotionGate (§11.2)', () => {
  function statsOf(over: Partial<ReturnType<typeof summarizeHumanLabelStats>>) {
    return summarizeHumanLabelStats([]) && {
      resolvedTotal: 0,
      resolvedManual: 0,
      resolvedDerived: 0,
      pendingContext: 0,
      undecidable: 0,
      byCategory: { 긍정: 0, 중립: 0, 부정: 0 },
      byCategoryManual: { 긍정: 0, 중립: 0, 부정: 0 },
      byFineLabel: { 기쁨: 0, 놀람: 0, 슬픔: 0, 분노: 0, 불안: 0, 당황: 0, 중립: 0 },
      ...over,
    }
  }
  it('E0: 비어있음', () => {
    expect(computeEmotionGate(statsOf({})).gate).toBe('E0')
  })
  it('E1: resolved >= 10 (학습 금지)', () => {
    expect(computeEmotionGate(statsOf({ resolvedTotal: 10, resolvedDerived: 10 })).gate).toBe('E1')
  })
  it('E2: manual>=50 ∧ total>=200 ∧ 3 category(gold) 존재', () => {
    const g = computeEmotionGate(
      statsOf({
        resolvedTotal: 200,
        resolvedManual: 50,
        byCategory: { 긍정: 20, 중립: 15, 부정: 15 },
        byCategoryManual: { 긍정: 20, 중립: 15, 부정: 15 },
      }),
    )
    expect(g.gate).toBe('E2')
  })
  it('E2 미달: gold category 중 하나라도 0이면 E1로 강등', () => {
    const g = computeEmotionGate(
      statsOf({
        resolvedTotal: 200,
        resolvedManual: 50,
        byCategory: { 긍정: 30, 중립: 20, 부정: 0 },
        byCategoryManual: { 긍정: 30, 중립: 20, 부정: 0 },
      }),
    )
    expect(g.gate).toBe('E1')
  })
  it('E4: manual>=500 ∧ total>=3000 ∧ category별>=100', () => {
    const g = computeEmotionGate(
      statsOf({
        resolvedTotal: 3000,
        resolvedManual: 500,
        byCategory: { 긍정: 100, 중립: 100, 부정: 100 },
        byCategoryManual: { 긍정: 100, 중립: 100, 부정: 100 },
      }),
    )
    expect(g.gate).toBe('E4')
    expect(g.nextRequired).toBeNull()
  })

  // ── manual gold 기준 정밀도 보정 (derived inflation 방지) ──────────────────
  it('E4 부적격: derived 가 category 를 부풀려도 manual gold 가 category별 100 미만이면 E4 아님(E3)', () => {
    // byCategory(합산) 은 모두 ≥100 이지만 byCategoryManual(gold) 의 부정은 50 → E4 미달, E3.
    const g = computeEmotionGate(
      statsOf({
        resolvedTotal: 3000,
        resolvedManual: 500,
        byCategory: { 긍정: 150, 중립: 150, 부정: 150 },
        byCategoryManual: { 긍정: 150, 중립: 150, 부정: 50 },
      }),
    )
    expect(g.gate).toBe('E3')
  })

  it('E2 부적격: derived 로 3 category 가 채워져도 manual gold 가 한 category 0 이면 E2 아님(E1)', () => {
    // byCategory(합산) 은 3 category 모두 >0 이지만 byCategoryManual 의 부정 gold=0 → E2 미달, E1.
    const g = computeEmotionGate(
      statsOf({
        resolvedTotal: 200,
        resolvedManual: 50,
        byCategory: { 긍정: 30, 중립: 20, 부정: 10 },
        byCategoryManual: { 긍정: 30, 중립: 20, 부정: 0 },
      }),
    )
    expect(g.gate).toBe('E1')
  })
})

import { buildHumanLabelUpsert } from './humanLabelReview.js'

describe('buildHumanLabelUpsert (PR-H2a-api 저장)', () => {
  const ctx = { utteranceId: 'utt_1', sessionId: 'sess_1', labelerId: 'uid-9', labelerEmail: 'a@b.c' }
  const NOW = '2026-05-25T00:00:00.000Z'

  it('resolved + fine + category → row, source=manual, utterances.emotion 무관', () => {
    const r = buildHumanLabelUpsert({ fine_label: '기쁨', emotion_category: '긍정', category_decision: 'resolved' }, ctx, NOW)
    expect('row' in r).toBe(true)
    if ('row' in r) {
      expect(r.row.category_source).toBe('manual')
      expect(r.row.label_type).toBe('emotion')
      expect(r.row.utterance_id).toBe('utt_1')
      expect(r.row.session_id).toBe('sess_1')
      expect(r.row.labeler_id).toBe('uid-9')
      expect(r.row.labeler_email).toBe('a@b.c')
      expect(r.row.updated_at).toBe(NOW)
    }
  })

  it('undecidable → category/source null 허용, fine null 허용', () => {
    const r = buildHumanLabelUpsert({ category_decision: 'undecidable' }, ctx, NOW)
    expect('row' in r).toBe(true)
    if ('row' in r) {
      expect(r.row.category_source).toBeNull()
      expect(r.row.emotion_category).toBeNull()
      expect(r.row.fine_label).toBeNull()
    }
  })

  it('resolved 인데 emotion_category 누락 → error(400 사유)', () => {
    const r = buildHumanLabelUpsert({ fine_label: '기쁨', category_decision: 'resolved' }, ctx, NOW)
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/resolved requires fine_label and emotion_category/)
  })

  it('resolved 인데 fine_label 누락 → error', () => {
    const r = buildHumanLabelUpsert({ emotion_category: '긍정', category_decision: 'resolved' }, ctx, NOW)
    expect('error' in r).toBe(true)
  })

  it('잘못된 category_decision → error', () => {
    const r = buildHumanLabelUpsert({ category_decision: 'bogus' }, ctx, NOW)
    expect('error' in r && /invalid category_decision/.test(r.error)).toBe(true)
  })

  it('잘못된 label_confidence → error', () => {
    const r = buildHumanLabelUpsert({ category_decision: 'undecidable', label_confidence: 'huge' }, ctx, NOW)
    expect('error' in r && /label_confidence/.test(r.error)).toBe(true)
  })

  it('note/label_confidence passthrough + email 없으면 null', () => {
    const r = buildHumanLabelUpsert(
      { fine_label: '슬픔', emotion_category: '부정', category_decision: 'resolved', label_confidence: 'high', note: '확실' },
      { utteranceId: 'u', sessionId: 's', labelerId: 'x' },
      NOW,
    )
    expect('row' in r).toBe(true)
    if ('row' in r) {
      expect(r.row.label_confidence).toBe('high')
      expect(r.row.note).toBe('확실')
      expect(r.row.labeler_email).toBeNull()
    }
  })
})
