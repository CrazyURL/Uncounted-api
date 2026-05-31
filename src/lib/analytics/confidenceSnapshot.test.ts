import { describe, it, expect } from 'vitest'
import { buildConfidenceSnapshot } from './confidenceSnapshot.js'

const u = (
  session_id: string,
  emotion_confidence: number | string | null = null,
  label_confidence: number | string | null = null,
) => ({ session_id, emotion_confidence, label_confidence })

describe('buildConfidenceSnapshot — basic', () => {
  it('empty input → zero counts + null stats', () => {
    const r = buildConfidenceSnapshot({ utterances: [] })
    expect(r.total_sessions).toBe(0)
    expect(r.total_utterances_scanned).toBe(0)
    expect(r.by_tier).toEqual({ high: 0, medium: 0, needs_review: 0 })
    expect(r.by_source).toEqual({ label: 0, emotion: 0, none: 0 })
    expect(r.needs_review_ratio).toBe(0)
    expect(r.emotion_stats.n).toBe(0)
    expect(r.emotion_stats.mean).toBe(null)
    expect(r.label_stats.n).toBe(0)
  })

  it('all null → all needs_review + source=none', () => {
    const r = buildConfidenceSnapshot({ utterances: [u('s1'), u('s1'), u('s2')] })
    expect(r.by_tier.needs_review).toBe(3)
    expect(r.by_source.none).toBe(3)
    expect(r.needs_review_ratio).toBe(1)
  })
})

describe('buildConfidenceSnapshot — tier 분포', () => {
  it('emotion only 분포 (label 100% null)', () => {
    const r = buildConfidenceSnapshot({
      utterances: [
        u('s1', 0.9),    // high
        u('s1', 0.5),    // medium
        u('s1', 0.3),    // needs_review (<0.4)
        u('s1', null),   // needs_review (null)
      ],
    })
    expect(r.by_tier).toEqual({ high: 1, medium: 1, needs_review: 2 })
    expect(r.by_source).toEqual({ label: 0, emotion: 3, none: 1 })
    expect(r.needs_review_ratio).toBe(0.5)
  })

  it('label 우선 → source=label', () => {
    const r = buildConfidenceSnapshot({
      utterances: [
        u('s1', 0.5, 0.95),  // label 우선 → high (label)
        u('s1', 0.5, null),  // label null → emotion fallback → medium (emotion)
      ],
    })
    expect(r.by_tier.high).toBe(1)
    expect(r.by_tier.medium).toBe(1)
    expect(r.by_source).toEqual({ label: 1, emotion: 1, none: 0 })
  })

  it('boundary 0.7 → high / 0.4 → medium / 0.39 → needs_review', () => {
    const r = buildConfidenceSnapshot({
      utterances: [u('s1', 0.7), u('s1', 0.4), u('s1', 0.39)],
    })
    expect(r.by_tier).toEqual({ high: 1, medium: 1, needs_review: 1 })
  })
})

describe('buildConfidenceSnapshot — stats', () => {
  it('emotion_stats: mean/median/min/max', () => {
    const r = buildConfidenceSnapshot({
      utterances: [u('s1', 0.2), u('s1', 0.4), u('s1', 0.6), u('s1', 0.8), u('s1', 1.0)],
    })
    expect(r.emotion_stats.n).toBe(5)
    expect(r.emotion_stats.min).toBe(0.2)
    expect(r.emotion_stats.max).toBe(1)
    expect(r.emotion_stats.median).toBe(0.6)
    expect(r.emotion_stats.mean).toBeCloseTo(0.6, 1)
  })

  it('label_stats: 100% null → all-null stats', () => {
    const r = buildConfidenceSnapshot({
      utterances: [u('s1', 0.5), u('s1', 0.5), u('s1', 0.5)],
    })
    expect(r.label_stats.n).toBe(0)
    expect(r.label_stats.mean).toBe(null)
    expect(r.label_stats.median).toBe(null)
  })

  it('string parse + invalid → none', () => {
    const r = buildConfidenceSnapshot({
      utterances: [u('s1', '0.8'), u('s1', 'abc'), u('s1', '')],
    })
    expect(r.by_source.emotion).toBe(1)
    expect(r.by_source.none).toBe(2)
  })

  it('NaN / Infinity → none', () => {
    const r = buildConfidenceSnapshot({
      utterances: [u('s1', NaN), u('s1', Infinity)],
    })
    expect(r.by_source.none).toBe(2)
  })
})

describe('buildConfidenceSnapshot — session breakdown', () => {
  it('needs_review_ratio 높은 순 정렬', () => {
    const r = buildConfidenceSnapshot({
      utterances: [
        u('s1', 0.9), u('s1', 0.9),                  // s1: 0% needs_review
        u('s2', 0.3), u('s2', 0.3), u('s2', 0.3),    // s2: 100%
        u('s3', 0.3), u('s3', 0.9),                  // s3: 50%
      ],
    })
    expect(r.session_breakdown[0].needs_review_ratio).toBe(1)
    expect(r.session_breakdown[0].id_prefix.startsWith('s2')).toBe(true)
    expect(r.session_breakdown[1].id_prefix.startsWith('s3')).toBe(true)
  })

  it('id_prefix 8자 + 말줄임 (원문 0)', () => {
    const r = buildConfidenceSnapshot({ utterances: [u('abcdefghijklmnop12345', 0.9)] })
    expect(r.session_breakdown[0].id_prefix).toBe('abcdefgh…')
  })

  it('top_limit 옵션 적용', () => {
    const utts = []
    for (let i = 0; i < 100; i++) utts.push(u(`s${i}`, 0.3))
    const r = buildConfidenceSnapshot({ utterances: utts }, { topLimit: 5 })
    expect(r.session_breakdown.length).toBe(5)
    expect(r.total_sessions).toBe(100)
  })
})

describe('buildConfidenceSnapshot — leak guard', () => {
  it('session_breakdown 항목에 transcript_text / surface 부재', () => {
    const r = buildConfidenceSnapshot({ utterances: [u('s1', 0.9)] })
    const row = r.session_breakdown[0] as unknown as Record<string, unknown>
    expect('transcript_text' in row).toBe(false)
    expect('label_confidence' in row).toBe(false)
    expect('emotion_confidence' in row).toBe(false)
    expect('text' in row).toBe(false)
  })
})

describe('Phase C 실측 분포 fixture', () => {
  it('founder 코퍼스 동등 — emotion mean ~0.627, label 100% null', () => {
    // 분포 모사: high 27 / medium 56 / needs_review 17 (= 4 + 13 null)
    const utts: ReturnType<typeof u>[] = []
    for (let i = 0; i < 27; i++) utts.push(u('p', 0.8))     // high
    for (let i = 0; i < 56; i++) utts.push(u('p', 0.55))    // medium
    for (let i = 0; i < 4; i++) utts.push(u('p', 0.3))       // needs_review (<0.4)
    for (let i = 0; i < 13; i++) utts.push(u('p', null))     // null fallback

    const r = buildConfidenceSnapshot({ utterances: utts })
    expect(r.by_tier.high).toBe(27)
    expect(r.by_tier.medium).toBe(56)
    expect(r.by_tier.needs_review).toBe(17)
    expect(r.by_source.label).toBe(0)
    expect(r.by_source.emotion).toBe(87)
    expect(r.by_source.none).toBe(13)
    // founder reality: label_confidence 0건 = label_stats null
    expect(r.label_stats.n).toBe(0)
    // needs_review_ratio = 17/100 = 0.17
    expect(r.needs_review_ratio).toBeCloseTo(0.17, 2)
  })
})
