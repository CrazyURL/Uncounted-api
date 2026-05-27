import { describe, it, expect } from 'vitest'
import {
  resolveIsOverlapping,
  toOverlapScoreExtension,
  toOverlapRegionExtension,
  toInterruptionCandidateExtension,
  buildUtteranceOverlapMetadata,
  OVERLAP_DISCLOSURE,
  type OverlapCandidateSignals,
} from './overlapMetadata.js'

describe('resolveIsOverlapping (3-state: true/false/unknown)', () => {
  it('explicit true candidate → value true, candidate_flag, heuristic_mvp', () => {
    const r = resolveIsOverlapping({ is_overlapping: true })
    expect(r.value).toBe(true)
    expect(r.source).toBe('candidate_flag')
    expect(r.method).toBe('heuristic_mvp')
  })

  it('explicit false candidate → value false (NOT unknown)', () => {
    const r = resolveIsOverlapping({ is_overlapping: false })
    expect(r.value).toBe(false)
    expect(r.source).toBe('candidate_flag')
  })

  it('no signal → unknown (value null, not false) — false 날조 금지', () => {
    const r = resolveIsOverlapping({})
    expect(r.value).toBeNull()
    expect(r.value).not.toBe(false)
    expect(r.source).toBe('unknown')
    expect(r.method).toBe('not_available')
  })

  it('null/undefined/non-boolean candidate → unknown', () => {
    expect(resolveIsOverlapping({ is_overlapping: null }).value).toBeNull()
    expect(resolveIsOverlapping({ is_overlapping: undefined }).value).toBeNull()
    expect(resolveIsOverlapping({ is_overlapping: 1 as unknown as boolean }).value).toBeNull()
  })

  it('does NOT derive is_overlapping from overlap_score (detection 융합 금지)', () => {
    // high score but no explicit flag → still unknown, never true
    const r = resolveIsOverlapping({ overlap_score: 0.95 })
    expect(r.value).toBeNull()
    expect(r.source).toBe('unknown')
  })
})

describe('toOverlapScoreExtension', () => {
  it('valid score → clamped [0,1], heuristic_mvp, confidence null', () => {
    const ext = toOverlapScoreExtension(0.7)
    expect(ext.value).toBe(0.7)
    expect(ext.method).toBe('heuristic_mvp')
    expect(ext.version).toBe('heuristic_mvp')
    expect(ext.confidence).toBeNull()
  })

  it('out-of-range score clamps', () => {
    expect(toOverlapScoreExtension(1.5).value).toBe(1)
    expect(toOverlapScoreExtension(-0.2).value).toBe(0)
  })

  it('invalid score → value null, method not_available', () => {
    expect(toOverlapScoreExtension(null).value).toBeNull()
    expect(toOverlapScoreExtension(NaN).value).toBeNull()
    expect(toOverlapScoreExtension('0.5').value).toBeNull()
    expect(toOverlapScoreExtension(undefined).method).toBe('not_available')
  })
})

describe('toOverlapRegionExtension', () => {
  it('valid ms spans pass through (start_ms/end_ms emit-surface naming)', () => {
    const ext = toOverlapRegionExtension([{ start_ms: 100, end_ms: 250 }])
    expect(ext.value).toEqual([{ start_ms: 100, end_ms: 250 }])
    expect(ext.method).toBe('heuristic_mvp')
  })

  it('drops malformed entries; all-invalid → null', () => {
    expect(toOverlapRegionExtension([]).value).toBeNull()
    expect(toOverlapRegionExtension('nope').value).toBeNull()
    expect(toOverlapRegionExtension([{ start_ms: 'a', end_ms: 1 }]).value).toBeNull()
    // end < start is dropped
    expect(toOverlapRegionExtension([{ start_ms: 500, end_ms: 100 }]).value).toBeNull()
  })

  it('keeps valid entries while dropping invalid ones', () => {
    const ext = toOverlapRegionExtension([
      { start_ms: 0, end_ms: 50 },
      { start_ms: 99, end_ms: 10 }, // invalid (end<start), dropped
      { start_ms: 200, end_ms: 300 },
    ])
    expect(ext.value).toEqual([
      { start_ms: 0, end_ms: 50 },
      { start_ms: 200, end_ms: 300 },
    ])
  })
})

describe('toInterruptionCandidateExtension', () => {
  it('explicit boolean passes through', () => {
    expect(toInterruptionCandidateExtension(true).value).toBe(true)
    expect(toInterruptionCandidateExtension(false).value).toBe(false)
  })

  it('non-boolean → null (unknown, not false)', () => {
    const ext = toInterruptionCandidateExtension(undefined)
    expect(ext.value).toBeNull()
    expect(ext.value).not.toBe(false)
    expect(ext.method).toBe('not_available')
  })
})

describe('buildUtteranceOverlapMetadata', () => {
  it('no signals (default) → unknown baseline + all extension values null', () => {
    const m = buildUtteranceOverlapMetadata()
    expect(m.is_overlapping).toBeNull()
    expect(m.is_overlapping_source).toBe('unknown')
    expect(m.extensions.overlap_score.value).toBeNull()
    expect(m.extensions.overlap_region.value).toBeNull()
    expect(m.extensions.interruption_candidate.value).toBeNull()
  })

  it('full candidate signals map into baseline + extensions', () => {
    const signals: OverlapCandidateSignals = {
      is_overlapping: true,
      overlap_score: 0.6,
      overlap_region: [{ start_ms: 10, end_ms: 40 }],
      interruption_candidate: true,
    }
    const m = buildUtteranceOverlapMetadata(signals)
    expect(m.is_overlapping).toBe(true)
    expect(m.is_overlapping_source).toBe('candidate_flag')
    expect(m.extensions.overlap_score.value).toBe(0.6)
    expect(m.extensions.overlap_region.value).toEqual([{ start_ms: 10, end_ms: 40 }])
    expect(m.extensions.interruption_candidate.value).toBe(true)
  })

  it('is_overlapping is baseline boolean|null, extensions carry envelope shape', () => {
    const m = buildUtteranceOverlapMetadata({ overlap_score: 0.3 })
    // is_overlapping unknown, but score extension still present with envelope
    expect(m.is_overlapping).toBeNull()
    expect(m.extensions.overlap_score).toHaveProperty('value')
    expect(m.extensions.overlap_score).toHaveProperty('method')
    expect(m.extensions.overlap_score).toHaveProperty('version')
    expect(m.extensions.overlap_score).toHaveProperty('confidence')
  })
})

describe('D2 positioning lock (value enhancer, not survival condition)', () => {
  it('disclosure explicitly states mono limit + non-fail-closed posture', () => {
    expect(OVERLAP_DISCLOSURE).toMatch(/Mono/i)
    expect(OVERLAP_DISCLOSURE).toMatch(/NOT guaranteed/i)
    expect(OVERLAP_DISCLOSURE).toMatch(/value-enhancer/i)
    expect(OVERLAP_DISCLOSURE).toMatch(/NOT a delivery survival condition/i)
    expect(OVERLAP_DISCLOSURE).toMatch(/fail-closed/i)
  })
})
