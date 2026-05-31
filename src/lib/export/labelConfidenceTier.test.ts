import { describe, it, expect } from 'vitest'
import {
  computeLabelConfidenceTier,
  isConfidenceTier,
  type LabelConfidenceTierInput,
} from './labelConfidenceTier.js'

const c = (i: LabelConfidenceTierInput) => computeLabelConfidenceTier(i)

// ── label_confidence 우선 ─────────────────────────────────────────────────

describe('computeLabelConfidenceTier — label > emotion > none', () => {
  it('label 0.95 → high (source=label)', () => {
    const r = c({ label_confidence: 0.95, emotion_confidence: 0.3 })
    expect(r.tier).toBe('high'); expect(r.source).toBe('label'); expect(r.value).toBe(0.95)
  })
  it('label 0.7 boundary → high', () => {
    expect(c({ label_confidence: 0.7 }).tier).toBe('high')
  })
  it('label 0.5 → medium', () => {
    expect(c({ label_confidence: 0.5 }).tier).toBe('medium')
  })
  it('label 0.4 boundary → medium', () => {
    expect(c({ label_confidence: 0.4 }).tier).toBe('medium')
  })
  it('label 0.39 → needs_review', () => {
    expect(c({ label_confidence: 0.39 }).tier).toBe('needs_review')
  })
  it('label 0 → needs_review', () => {
    expect(c({ label_confidence: 0 }).tier).toBe('needs_review')
  })
  it('label null → emotion fallback', () => {
    const r = c({ label_confidence: null, emotion_confidence: 0.8 })
    expect(r.tier).toBe('high'); expect(r.source).toBe('emotion'); expect(r.value).toBe(0.8)
  })
  it('label undefined → emotion fallback', () => {
    expect(c({ emotion_confidence: 0.5 }).source).toBe('emotion')
  })
  it('둘 다 null → needs_review (source=none, value=null)', () => {
    const r = c({})
    expect(r.tier).toBe('needs_review'); expect(r.source).toBe('none'); expect(r.value).toBe(null)
  })
  it('둘 다 null 명시 → needs_review (source=none)', () => {
    expect(c({ label_confidence: null, emotion_confidence: null }).source).toBe('none')
  })
})

// ── number-like string parse ─────────────────────────────────────────────

describe('number-like string', () => {
  it('label "0.8" → high', () => {
    const r = c({ label_confidence: '0.8' })
    expect(r.tier).toBe('high'); expect(r.value).toBe(0.8)
  })
  it('label " 0.5 " whitespace → medium', () => {
    expect(c({ label_confidence: ' 0.5 ' }).tier).toBe('medium')
  })
  it('label "" empty → emotion fallback', () => {
    expect(c({ label_confidence: '', emotion_confidence: 0.8 }).source).toBe('emotion')
  })
  it('label "abc" invalid → emotion fallback', () => {
    expect(c({ label_confidence: 'abc', emotion_confidence: 0.5 }).source).toBe('emotion')
  })
  it('label NaN → emotion fallback', () => {
    expect(c({ label_confidence: NaN, emotion_confidence: 0.5 }).source).toBe('emotion')
  })
  it('label Infinity → emotion fallback', () => {
    expect(c({ label_confidence: Infinity, emotion_confidence: 0.5 }).source).toBe('emotion')
  })
})

// ── boundary 정확 ─────────────────────────────────────────────────────────

describe('boundaries', () => {
  it('0.7 정확 → high', () => { expect(c({ label_confidence: 0.7 }).tier).toBe('high') })
  it('0.6999 → medium', () => { expect(c({ label_confidence: 0.6999 }).tier).toBe('medium') })
  it('0.4 정확 → medium', () => { expect(c({ label_confidence: 0.4 }).tier).toBe('medium') })
  it('0.3999 → needs_review', () => { expect(c({ label_confidence: 0.3999 }).tier).toBe('needs_review') })
  it('1.0 → high', () => { expect(c({ label_confidence: 1.0 }).tier).toBe('high') })
  it('0.0 → needs_review', () => { expect(c({ label_confidence: 0.0 }).tier).toBe('needs_review') })
})

// ── defensive 음수/>1 ────────────────────────────────────────────────────

describe('defensive (음수/>1)', () => {
  it('-0.5 → needs_review (classify 그대로)', () => {
    expect(c({ label_confidence: -0.5 }).tier).toBe('needs_review')
  })
  it('1.5 → high (classify 그대로)', () => {
    expect(c({ label_confidence: 1.5 }).tier).toBe('high')
  })
})

// ── source 라벨 일관성 ─────────────────────────────────────────────────────

describe('source 라벨', () => {
  it('label 있고 emotion 도 있으면 source=label (우선)', () => {
    expect(c({ label_confidence: 0.5, emotion_confidence: 0.9 }).source).toBe('label')
  })
  it('label null + emotion 있으면 source=emotion', () => {
    expect(c({ emotion_confidence: 0.5 }).source).toBe('emotion')
  })
  it('둘 다 invalid → source=none', () => {
    expect(c({ label_confidence: 'foo', emotion_confidence: NaN }).source).toBe('none')
  })
})

// ── 9fa79d3c / Phase A+P1 fixture 회귀 (정본 측정 2026-05-31)  ────────────
// founder Tier-0 15 sessions / 546 utterances 실측 분포 검증.
// 분포: high=26.7% / medium=55.7% / needs_review(<0.4)=3.7% / null fallback=13.9%
// emotion_confidence mean=0.627 / median=0.621 / p25=0.517 / p75=0.723
// voice-api emotion-only v20260524_095713 macro_f1=0.5254 와 정합.

describe('Phase C 실측 fixture (founder 546 utt 합산 분포)', () => {
  const fixture = [
    // p75 0.723 → high
    { emotion_confidence: 0.723, expect: 'high' },
    // mean 0.627 → medium
    { emotion_confidence: 0.627, expect: 'medium' },
    // median 0.621 → medium
    { emotion_confidence: 0.621, expect: 'medium' },
    // p25 0.517 → medium
    { emotion_confidence: 0.517, expect: 'medium' },
    // min 0.35 → needs_review (<0.4)
    { emotion_confidence: 0.35, expect: 'needs_review' },
    // max 0.997 → high
    { emotion_confidence: 0.997, expect: 'high' },
    // null → needs_review (none)
    { emotion_confidence: null, expect: 'needs_review' },
  ] as const

  it.each(fixture)('emo=$emotion_confidence → $expect', ({ emotion_confidence, expect: t }) => {
    expect(c({ emotion_confidence }).tier).toBe(t)
  })

  it('label_confidence 100% null 시 emotion fallback 전체 동작 (founder dataset 특성)', () => {
    // 본 코퍼스 label_confidence 0/546 → 전수 emotion fallback
    for (const f of fixture) {
      const r = c({ label_confidence: null, emotion_confidence: f.emotion_confidence })
      expect(r.tier).toBe(f.expect)
      expect(r.source).toBe(f.emotion_confidence == null ? 'none' : 'emotion')
    }
  })
})

// ── isConfidenceTier helper ──────────────────────────────────────────────

describe('isConfidenceTier', () => {
  it('표준 3 tier', () => {
    expect(isConfidenceTier('high')).toBe(true)
    expect(isConfidenceTier('medium')).toBe(true)
    expect(isConfidenceTier('needs_review')).toBe(true)
  })
  it('non-표준', () => {
    expect(isConfidenceTier('A_tier')).toBe(false)
    expect(isConfidenceTier('low')).toBe(false)
    expect(isConfidenceTier(null)).toBe(false)
    expect(isConfidenceTier(undefined)).toBe(false)
    expect(isConfidenceTier(0.8)).toBe(false)
  })
})
