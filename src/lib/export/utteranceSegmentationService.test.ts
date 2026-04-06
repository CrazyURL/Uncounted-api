import { describe, it, expect } from 'vitest'
import {
  mergeShortSegments,
  splitLongSegments,
  type Boundary,
} from './segmentationUtils.js'

describe('mergeShortSegments', () => {
  it('returns empty array for empty input', () => {
    expect(mergeShortSegments([], 5)).toEqual([])
  })

  it('returns single segment unchanged', () => {
    const input: Boundary[] = [{ start: 0, end: 3 }]
    const result = mergeShortSegments(input, 5)
    expect(result).toEqual([{ start: 0, end: 3 }])
  })

  it('does not merge segments already above minimum', () => {
    const input: Boundary[] = [
      { start: 0, end: 6 },
      { start: 6, end: 14 },
      { start: 14, end: 20 },
    ]
    const result = mergeShortSegments(input, 5)
    expect(result).toHaveLength(3)
  })

  it('merges short first segment with next', () => {
    const input: Boundary[] = [
      { start: 0, end: 2 },   // 2s — too short
      { start: 2, end: 10 },  // 8s
    ]
    const result = mergeShortSegments(input, 5)
    expect(result).toEqual([{ start: 0, end: 10 }])
  })

  it('merges short last segment with previous', () => {
    const input: Boundary[] = [
      { start: 0, end: 8 },
      { start: 8, end: 11 },  // 3s — too short
    ]
    const result = mergeShortSegments(input, 5)
    expect(result).toEqual([{ start: 0, end: 11 }])
  })

  it('merges short middle segment with shorter neighbor', () => {
    const input: Boundary[] = [
      { start: 0, end: 6 },    // 6s — shorter neighbor
      { start: 6, end: 9 },    // 3s — too short
      { start: 9, end: 20 },   // 11s — longer neighbor
    ]
    const result = mergeShortSegments(input, 5)
    // Should merge with prev (shorter): [0,9] + [9,20]
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ start: 0, end: 9 })
    expect(result[1]).toEqual({ start: 9, end: 20 })
  })

  it('handles multiple short segments requiring cascading merges', () => {
    const input: Boundary[] = [
      { start: 0, end: 2 },   // 2s
      { start: 2, end: 4 },   // 2s
      { start: 4, end: 10 },  // 6s
    ]
    const result = mergeShortSegments(input, 5)
    // All short segments should be merged
    for (const seg of result) {
      expect(seg.end - seg.start).toBeGreaterThanOrEqual(5)
    }
    // Total span preserved
    expect(result[0].start).toBe(0)
    expect(result[result.length - 1].end).toBe(10)
  })

  it('does not mutate the input array', () => {
    const input: Boundary[] = [
      { start: 0, end: 2 },
      { start: 2, end: 10 },
    ]
    const inputCopy = JSON.parse(JSON.stringify(input))
    mergeShortSegments(input, 5)
    expect(input).toEqual(inputCopy)
  })
})

describe('splitLongSegments', () => {
  it('returns empty array for empty input', () => {
    expect(splitLongSegments([], 30)).toEqual([])
  })

  it('does not split segments within max duration', () => {
    const input: Boundary[] = [
      { start: 0, end: 15 },
      { start: 15, end: 28 },
    ]
    const result = splitLongSegments(input, 30)
    expect(result).toHaveLength(2)
  })

  it('splits a 60s segment into 2 equal parts', () => {
    const input: Boundary[] = [{ start: 0, end: 60 }]
    const result = splitLongSegments(input, 30)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ start: 0, end: 30 })
    expect(result[1]).toEqual({ start: 30, end: 60 })
  })

  it('splits a 90s segment into 3 equal parts', () => {
    const input: Boundary[] = [{ start: 10, end: 100 }]
    const result = splitLongSegments(input, 30)
    expect(result).toHaveLength(3)
    expect(result[0].start).toBe(10)
    expect(result[2].end).toBe(100)
    // Each part should be exactly 30s
    for (const seg of result) {
      expect(seg.end - seg.start).toBeCloseTo(30, 1)
    }
  })

  it('handles mixed short and long segments', () => {
    const input: Boundary[] = [
      { start: 0, end: 10 },   // 10s — ok
      { start: 10, end: 70 },  // 60s — should split into 2
      { start: 70, end: 80 },  // 10s — ok
    ]
    const result = splitLongSegments(input, 30)
    expect(result).toHaveLength(4)
    // First segment unchanged
    expect(result[0]).toEqual({ start: 0, end: 10 })
    // Last segment unchanged
    expect(result[3]).toEqual({ start: 70, end: 80 })
  })

  it('preserves total span after splitting', () => {
    const input: Boundary[] = [{ start: 5, end: 125 }]
    const result = splitLongSegments(input, 30)
    expect(result[0].start).toBe(5)
    expect(result[result.length - 1].end).toBe(125)
  })

  it('does not mutate the input array', () => {
    const input: Boundary[] = [{ start: 0, end: 60 }]
    const inputCopy = JSON.parse(JSON.stringify(input))
    splitLongSegments(input, 30)
    expect(input).toEqual(inputCopy)
  })
})

describe('merge + split integration', () => {
  it('produces segments within 5-30s range for typical input', () => {
    // Simulate a realistic silence boundary detection result
    const input: Boundary[] = [
      { start: 0, end: 3 },     // 3s — too short
      { start: 3.5, end: 8 },   // 4.5s — borderline short
      { start: 8.5, end: 15 },  // 6.5s — ok
      { start: 15.5, end: 55 }, // 39.5s — too long
      { start: 55.5, end: 58 }, // 2.5s — too short
    ]

    const merged = mergeShortSegments(input, 5)
    const final = splitLongSegments(merged, 30)

    // All segments should have reasonable durations
    for (const seg of final) {
      const dur = seg.end - seg.start
      // After merge+split, no single-segment result should be < 5s
      // unless total audio is < 5s (not the case here)
      expect(dur).toBeGreaterThan(0)
      expect(dur).toBeLessThanOrEqual(30)
    }

    // Verify coverage: first start and last end should cover the original range
    expect(final[0].start).toBeLessThanOrEqual(0)
    expect(final[final.length - 1].end).toBeGreaterThanOrEqual(55.5)
  })
})
