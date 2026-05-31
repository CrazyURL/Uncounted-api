import { describe, it, expect } from 'vitest'
import {
  computeGradeDistribution,
  computeSessionQualityTier,
  isComputedTier,
  type SessionQualityTierInput,
} from './sessionQualityTier.js'

// ── helper: utterances fixture ───────────────────────────────────────────
function utts(grades: ReadonlyArray<string | null>): Array<{ quality_grade: string | null }> {
  return grades.map((g) => ({ quality_grade: g }))
}

function build(grades: ReadonlyArray<string | null>): SessionQualityTierInput {
  return { utterances: utts(grades) }
}

// ── distribution ──────────────────────────────────────────────────────────

describe('computeGradeDistribution', () => {
  it('empty', () => {
    expect(computeGradeDistribution([])).toEqual({ A: 0, B: 0, C: 0, D: 0, F: 0, null: 0 })
  })
  it('null/undefined utterances', () => {
    expect(computeGradeDistribution(null)).toEqual({ A: 0, B: 0, C: 0, D: 0, F: 0, null: 0 })
    expect(computeGradeDistribution(undefined)).toEqual({ A: 0, B: 0, C: 0, D: 0, F: 0, null: 0 })
  })
  it('all grades', () => {
    expect(computeGradeDistribution(utts(['A', 'A', 'B', 'C', 'D', 'F', null]))).toEqual({
      A: 2,
      B: 1,
      C: 1,
      D: 1,
      F: 1,
      null: 1,
    })
  })
  it('lowercase + whitespace normalized', () => {
    expect(computeGradeDistribution(utts(['a', ' B ', 'c']))).toEqual({
      A: 1,
      B: 1,
      C: 1,
      D: 0,
      F: 0,
      null: 0,
    })
  })
  it('invalid grade → null bucket', () => {
    expect(computeGradeDistribution(utts(['Z', 'X', null]))).toEqual({
      A: 0,
      B: 0,
      C: 0,
      D: 0,
      F: 0,
      null: 3,
    })
  })
})

// ── tier 산정 — computed (DB 부재) ───────────────────────────────────────

describe('computeSessionQualityTier — computed (no db_value)', () => {
  it('all A → A_tier', () => {
    const r = computeSessionQualityTier(build(['A', 'A', 'A', 'A']))
    expect(r.tier).toBe('A_tier')
    expect(r.source).toBe('computed')
    expect(r.metrics.total).toBe(4)
    expect(r.metrics.ab_ratio).toBe(1)
    expect(r.metrics.df_ratio).toBe(0)
  })

  it('all B → A_tier (A+B=1.0, D/F=0)', () => {
    const r = computeSessionQualityTier(build(['B', 'B', 'B']))
    expect(r.tier).toBe('A_tier')
  })

  it('mostly A+B, no D/F (A+B=0.95, D/F=0) → A_tier', () => {
    // total 20, A+B=19, C=1, D/F=0 → 0.95 >= 0.9 and D/F=0 → A_tier
    const grades = [...Array(15).fill('A'), ...Array(4).fill('B'), 'C']
    const r = computeSessionQualityTier(build(grades))
    expect(r.tier).toBe('A_tier')
    expect(r.metrics.total).toBe(20)
  })

  it('A+B=0.9 exactly with no D/F → A_tier (boundary)', () => {
    const grades = [...Array(9).fill('A'), 'C']
    const r = computeSessionQualityTier(build(grades))
    expect(r.tier).toBe('A_tier')
  })

  it('A+B=0.9 but D=1 → B_tier (D/F!=0 blocks A_tier)', () => {
    // total 10, A=8, B=1, D=1, F=0 → A+B=0.9, D/F=0.1 → A_tier 차단(D/F=0 위배),
    // B_tier 도 차단(df_ratio=0.1 > 0.05). C_tier (A+B=0.9 >= 0.5).
    const grades = [...Array(8).fill('A'), 'B', 'D']
    const r = computeSessionQualityTier(build(grades))
    expect(r.tier).toBe('C_tier')
    expect(r.metrics.df_ratio).toBe(0.1)
  })

  it('mostly B, A+B=0.8, D/F=0 → B_tier', () => {
    // total 10, A=2, B=6, C=2, D/F=0 → A+B=0.8, df_ratio=0 → B_tier (0.7-0.9)
    const grades = ['A', 'A', ...Array(6).fill('B'), 'C', 'C']
    const r = computeSessionQualityTier(build(grades))
    expect(r.tier).toBe('B_tier')
    expect(r.metrics.ab_ratio).toBe(0.8)
  })

  it('A+B=0.7 + D/F=0.04 → B_tier (boundary)', () => {
    // total 100, A=50, B=20, C=26, D=4, F=0 → A+B=0.7, D/F=0.04 → B_tier
    const grades = [...Array(50).fill('A'), ...Array(20).fill('B'), ...Array(26).fill('C'), ...Array(4).fill('D')]
    const r = computeSessionQualityTier(build(grades))
    expect(r.tier).toBe('B_tier')
    expect(r.metrics.ab_ratio).toBe(0.7)
    expect(r.metrics.df_ratio).toBe(0.04)
  })

  it('mixed C — A+B=0.6, D/F=0 → C_tier', () => {
    // total 10, A=3, B=3, C=4 → A+B=0.6 → C_tier
    const grades = [...Array(3).fill('A'), ...Array(3).fill('B'), ...Array(4).fill('C')]
    const r = computeSessionQualityTier(build(grades))
    expect(r.tier).toBe('C_tier')
  })

  it('A+B=0.5 exactly → C_tier (boundary)', () => {
    const grades = ['A', 'A', 'B', 'B', 'C', 'C', 'C', 'C']
    const r = computeSessionQualityTier(build(grades))
    expect(r.tier).toBe('C_tier')
    expect(r.metrics.ab_ratio).toBe(0.5)
  })

  it('D/F 많음 → D_tier (A+B<0.5)', () => {
    // total 10, A=2, B=2, C=2, D=2, F=2 → A+B=0.4 → D_tier
    const grades = ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F']
    const r = computeSessionQualityTier(build(grades))
    expect(r.tier).toBe('D_tier')
    expect(r.metrics.df_ratio).toBe(0.4)
  })

  it('all D/F → D_tier', () => {
    const r = computeSessionQualityTier(build(['D', 'D', 'F', 'F']))
    expect(r.tier).toBe('D_tier')
    expect(r.metrics.ab_ratio).toBe(0)
  })

  it('partial null reduces ab_ratio → D_tier 가능', () => {
    // total 10, A=4, null=6 → A+B=0.4 → D_tier (전부 null 아님 → UNKNOWN 아님)
    const grades = [...Array(4).fill('A'), ...Array(6).fill(null)]
    const r = computeSessionQualityTier(build(grades))
    expect(r.tier).toBe('D_tier')
    expect(r.metrics.total).toBe(10)
  })
})

// ── tier 산정 — UNKNOWN ──────────────────────────────────────────────────

describe('computeSessionQualityTier — UNKNOWN', () => {
  it('total=0 (no utterances) → UNKNOWN', () => {
    const r = computeSessionQualityTier({ utterances: [] })
    expect(r.tier).toBe('UNKNOWN')
    expect(r.source).toBe('unknown')
    expect(r.tier_reason).toBe('no_utterances')
  })
  it('utterances null → UNKNOWN', () => {
    const r = computeSessionQualityTier({ utterances: null })
    expect(r.tier).toBe('UNKNOWN')
    expect(r.tier_reason).toBe('no_utterances')
  })
  it('utterances undefined → UNKNOWN', () => {
    const r = computeSessionQualityTier({})
    expect(r.tier).toBe('UNKNOWN')
  })
  it('all grades null → UNKNOWN (all_null_grades)', () => {
    const r = computeSessionQualityTier(build([null, null, null]))
    expect(r.tier).toBe('UNKNOWN')
    expect(r.tier_reason).toBe('all_null_grades')
  })
  it('invalid grades (Z) treated as null → UNKNOWN', () => {
    const r = computeSessionQualityTier(build(['Z', 'X', 'Y']))
    expect(r.tier).toBe('UNKNOWN')
    expect(r.tier_reason).toBe('all_null_grades')
  })
})

// ── DB 값 override ───────────────────────────────────────────────────────

describe('computeSessionQualityTier — DB value override', () => {
  it('db_value 존재 시 utterances 무시 (source=db)', () => {
    const r = computeSessionQualityTier({
      db_value: 'A_tier',
      utterances: utts(['D', 'D', 'F', 'F']),  // computed 하면 D_tier
    })
    expect(r.tier).toBe('A_tier')
    expect(r.source).toBe('db')
    expect(r.tier_reason).toBe('db_value')
    // metrics 는 그대로 산출 (관찰용)
    expect(r.metrics.total).toBe(4)
  })

  it('db_value 임의 문자열 그대로 emit (eligibility 측에서 reject 룰 별도 적용)', () => {
    const r = computeSessionQualityTier({
      db_value: 'reject',
      utterances: utts(['A', 'A']),
    })
    expect(r.tier).toBe('reject')
    expect(r.source).toBe('db')
  })

  it('db_value 빈 문자열/whitespace → DB 값 부재로 간주, computed fallback', () => {
    const r1 = computeSessionQualityTier({ db_value: '', utterances: utts(['A']) })
    expect(r1.source).toBe('computed')
    expect(r1.tier).toBe('A_tier')
    const r2 = computeSessionQualityTier({ db_value: '   ', utterances: utts(['A']) })
    expect(r2.source).toBe('computed')
    expect(r2.tier).toBe('A_tier')
  })

  it('db_value null → computed fallback', () => {
    const r = computeSessionQualityTier({ db_value: null, utterances: utts(['A', 'B']) })
    expect(r.source).toBe('computed')
    expect(r.tier).toBe('A_tier')
  })
})

// ── 9fa79d3c fixture 회귀 (디렉티브) ─────────────────────────────────────

describe('9fa79d3c 동등 fixture', () => {
  it('A=4, B=61, others=0 → A_tier (A+B=1.0, D/F=0, source=computed)', () => {
    const grades = [...Array(4).fill('A'), ...Array(61).fill('B')]
    const r = computeSessionQualityTier(build(grades))
    expect(r.tier).toBe('A_tier')
    expect(r.source).toBe('computed')
    expect(r.metrics.total).toBe(65)
    expect(r.metrics.distribution).toEqual({ A: 4, B: 61, C: 0, D: 0, F: 0, null: 0 })
    expect(r.metrics.ab_ratio).toBe(1)
    expect(r.metrics.df_ratio).toBe(0)
  })
})

// ── isComputedTier helper ────────────────────────────────────────────────

describe('isComputedTier', () => {
  it('표준 5 tier', () => {
    expect(isComputedTier('A_tier')).toBe(true)
    expect(isComputedTier('B_tier')).toBe(true)
    expect(isComputedTier('C_tier')).toBe(true)
    expect(isComputedTier('D_tier')).toBe(true)
    expect(isComputedTier('UNKNOWN')).toBe(true)
  })
  it('non-표준', () => {
    expect(isComputedTier('reject')).toBe(false)
    expect(isComputedTier('A')).toBe(false)
    expect(isComputedTier(null)).toBe(false)
    expect(isComputedTier(undefined)).toBe(false)
    expect(isComputedTier(42)).toBe(false)
  })
})
