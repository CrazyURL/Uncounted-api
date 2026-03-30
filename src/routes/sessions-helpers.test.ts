import { describe, it, expect } from 'vitest'
import { clampQaScore } from './sessions-helpers'

describe('clampQaScore — H11 서버 측 qaScore 검증', () => {
  // 정상 범위
  it('50 → 50', () => {
    expect(clampQaScore(50)).toBe(50)
  })

  it('0 → 0 (최소값)', () => {
    expect(clampQaScore(0)).toBe(0)
  })

  it('100 → 100 (최대값)', () => {
    expect(clampQaScore(100)).toBe(100)
  })

  // 클램핑
  it('999 → 100 (상한 클램핑)', () => {
    expect(clampQaScore(999)).toBe(100)
  })

  it('-10 → 0 (하한 클램핑)', () => {
    expect(clampQaScore(-10)).toBe(0)
  })

  it('150 → 100', () => {
    expect(clampQaScore(150)).toBe(100)
  })

  // 반올림
  it('75.6 → 76 (반올림)', () => {
    expect(clampQaScore(75.6)).toBe(76)
  })

  it('75.4 → 75 (반올림)', () => {
    expect(clampQaScore(75.4)).toBe(75)
  })

  // 비정상 입력 → 0
  it('NaN → 0', () => {
    expect(clampQaScore(NaN)).toBe(0)
  })

  it('문자열 "80" → 0', () => {
    expect(clampQaScore('80')).toBe(0)
  })

  it('null → 0', () => {
    expect(clampQaScore(null)).toBe(0)
  })

  it('undefined → 0', () => {
    expect(clampQaScore(undefined)).toBe(0)
  })

  it('boolean true → 0', () => {
    expect(clampQaScore(true)).toBe(0)
  })
})
