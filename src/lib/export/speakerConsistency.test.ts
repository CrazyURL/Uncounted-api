import { describe, it, expect } from 'vitest'
import {
  normalizeConfidence,
  applyPenalties,
  computeSpeakerConsistency,
  toConsistencyExtension,
  DEFAULT_PENALTY_CONFIG,
  FILTERING_RELIABILITY_INTERPRETATION,
  PENALTY_NAMES,
  type PenaltyConfig,
  type UtteranceConfidenceInput,
} from './speakerConsistency.js'

describe('normalizeConfidence', () => {
  it('clamps valid in-range numbers to [0,1] unchanged', () => {
    expect(normalizeConfidence(0)).toBe(0)
    expect(normalizeConfidence(0.5)).toBe(0.5)
    expect(normalizeConfidence(1)).toBe(1)
  })

  it('clamps out-of-range numbers into [0,1]', () => {
    expect(normalizeConfidence(-0.3)).toBe(0)
    expect(normalizeConfidence(1.7)).toBe(1)
    expect(normalizeConfidence(-100)).toBe(0)
    expect(normalizeConfidence(100)).toBe(1)
  })

  it('returns null (unknown) for invalid input — NOT 0 (low)', () => {
    expect(normalizeConfidence(null)).toBeNull()
    expect(normalizeConfidence(undefined)).toBeNull()
    expect(normalizeConfidence(NaN)).toBeNull()
    expect(normalizeConfidence(Infinity)).toBeNull()
    expect(normalizeConfidence(-Infinity)).toBeNull()
    expect(normalizeConfidence('0.5')).toBeNull()
    expect(normalizeConfidence({})).toBeNull()
    expect(normalizeConfidence([])).toBeNull()
    expect(normalizeConfidence(true)).toBeNull()
  })
})

describe('applyPenalties', () => {
  it('default config (all not_configured) leaves base unchanged and lists not_configured signals', () => {
    const out = applyPenalties(0.8, { short_backchannel: true, is_overlapping: true })
    expect(out.value).toBe(0.8)
    expect(out.applied).toEqual([])
    expect(out.not_configured.sort()).toEqual(['is_overlapping', 'short_backchannel'])
  })

  it('does not list signals that are false/absent', () => {
    const out = applyPenalties(0.9, {})
    expect(out.value).toBe(0.9)
    expect(out.applied).toEqual([])
    expect(out.not_configured).toEqual([])
  })

  it('subtracts a configured numeric weight only for true signals and clamps to [0,1]', () => {
    const config: PenaltyConfig = {
      ...DEFAULT_PENALTY_CONFIG,
      short_backchannel: 0.2,
      is_overlapping: 0.1,
    }
    const out = applyPenalties(0.8, { short_backchannel: true, is_overlapping: false }, config)
    expect(out.value).toBeCloseTo(0.6, 10)
    expect(out.applied).toEqual(['short_backchannel'])
    expect(out.not_configured).toEqual([])
  })

  it('clamps to 0 when penalties exceed base', () => {
    const config: PenaltyConfig = { ...DEFAULT_PENALTY_CONFIG, short_backchannel: 0.9 }
    const out = applyPenalties(0.3, { short_backchannel: true }, config)
    expect(out.value).toBe(0)
  })
})

describe('computeSpeakerConsistency', () => {
  it('empty input → score null, coverage 0 (unknown, not low)', () => {
    const r = computeSpeakerConsistency([])
    expect(r.score).toBeNull()
    expect(r.coverage).toBe(0)
    expect(r.utterance_count).toBe(0)
    expect(r.scored_count).toBe(0)
  })

  it('all-invalid input → score null, coverage 0', () => {
    const inputs: UtteranceConfidenceInput[] = [
      { utterance_id: 'a', raw_confidence: null },
      { utterance_id: 'b', raw_confidence: 'x' },
      { utterance_id: 'c', raw_confidence: NaN },
    ]
    const r = computeSpeakerConsistency(inputs)
    expect(r.score).toBeNull()
    expect(r.coverage).toBe(0)
    expect(r.utterance_count).toBe(3)
    expect(r.scored_count).toBe(0)
  })

  it('length-weighted mean matches hand-computed value', () => {
    // (0.6*2 + 0.9*8) / (2+8) = (1.2 + 7.2)/10 = 0.84
    const inputs: UtteranceConfidenceInput[] = [
      { utterance_id: 'a', raw_confidence: 0.6, duration_sec: 2 },
      { utterance_id: 'b', raw_confidence: 0.9, duration_sec: 8 },
    ]
    const r = computeSpeakerConsistency(inputs)
    expect(r.score).toBeCloseTo(0.84, 10)
    expect(r.aggregation_method).toBe('length_weighted_mean')
    expect(r.scored_count).toBe(2)
    expect(r.coverage).toBe(1)
  })

  it('null/invalid duration_sec falls back to unit weight (1.0) → simple mean', () => {
    // both unit weight: (0.4 + 0.8)/2 = 0.6
    const inputs: UtteranceConfidenceInput[] = [
      { utterance_id: 'a', raw_confidence: 0.4, duration_sec: null },
      { utterance_id: 'b', raw_confidence: 0.8 },
    ]
    const r = computeSpeakerConsistency(inputs)
    expect(r.score).toBeCloseTo(0.6, 10)
  })

  it('zero / negative duration_sec falls back to unit weight (1.0), not dropped', () => {
    // 0 and -5 both → weight 1.0, plus 4 → weights (1,1,4): (0.2*1 + 0.4*1 + 0.9*4)/6 = 4.2/6 = 0.7
    const inputs: UtteranceConfidenceInput[] = [
      { utterance_id: 'a', raw_confidence: 0.2, duration_sec: 0 },
      { utterance_id: 'b', raw_confidence: 0.4, duration_sec: -5 },
      { utterance_id: 'c', raw_confidence: 0.9, duration_sec: 4 },
    ]
    const r = computeSpeakerConsistency(inputs)
    expect(r.score).toBeCloseTo(0.7, 10)
    expect(r.scored_count).toBe(3)
  })

  it('mixed valid/invalid → score from valid only, coverage = valid/total', () => {
    // valid: 0.5 (w1) and 1.2→clamp1 (w1) → (0.5+1)/2 = 0.75 ; coverage 2/4
    const inputs: UtteranceConfidenceInput[] = [
      { utterance_id: 'a', raw_confidence: 0.5 },
      { utterance_id: 'b', raw_confidence: 1.2 },
      { utterance_id: 'c', raw_confidence: null },
      { utterance_id: 'd', raw_confidence: 'nope' },
    ]
    const r = computeSpeakerConsistency(inputs)
    expect(r.score).toBeCloseTo(0.75, 10)
    expect(r.utterance_count).toBe(4)
    expect(r.scored_count).toBe(2)
    expect(r.coverage).toBe(0.5)
  })

  it('default config applies no penalties; reports not_configured names when signals present', () => {
    const inputs: UtteranceConfidenceInput[] = [
      { utterance_id: 'a', raw_confidence: 0.9, penalty_signals: { is_overlapping: true } },
    ]
    const r = computeSpeakerConsistency(inputs)
    expect(r.score).toBeCloseTo(0.9, 10)
    expect(r.penalties_applied_count).toBe(0)
    expect(r.penalties_not_configured).toEqual(['is_overlapping'])
  })

  it('configured penalty reduces the contributing score', () => {
    const config: PenaltyConfig = { ...DEFAULT_PENALTY_CONFIG, is_overlapping: 0.3 }
    const inputs: UtteranceConfidenceInput[] = [
      { utterance_id: 'a', raw_confidence: 0.9, penalty_signals: { is_overlapping: true } },
    ]
    const r = computeSpeakerConsistency(inputs, config)
    expect(r.score).toBeCloseTo(0.6, 10)
    expect(r.penalties_applied_count).toBe(1)
    expect(r.penalties_not_configured).toEqual([])
  })

  it('interpretation is locked to the filtering_reliability_score literal', () => {
    const r = computeSpeakerConsistency([{ utterance_id: 'a', raw_confidence: 0.5 }])
    expect(r.interpretation).toBe('filtering_reliability_score')
    expect(r.interpretation).toBe(FILTERING_RELIABILITY_INTERPRETATION)
  })
})

describe('toConsistencyExtension', () => {
  it('wraps the score in the uncounted_extensions envelope with confidence null', () => {
    const ext = toConsistencyExtension(0.84)
    expect(ext.value).toBe(0.84)
    expect(ext.confidence).toBeNull()
    expect(ext.method).toBe('heuristic_mvp')
    expect(ext.version).toBe('heuristic_mvp')
  })

  it('carries a null score through as value null (unknown preserved)', () => {
    const ext = toConsistencyExtension(null)
    expect(ext.value).toBeNull()
    expect(ext.confidence).toBeNull()
  })
})

describe('PENALTY_NAMES contract', () => {
  it('default config covers exactly the declared penalty names, all not_configured', () => {
    expect(Object.keys(DEFAULT_PENALTY_CONFIG).sort()).toEqual([...PENALTY_NAMES].sort())
    for (const name of PENALTY_NAMES) {
      expect(DEFAULT_PENALTY_CONFIG[name]).toBe('not_configured')
    }
  })
})
