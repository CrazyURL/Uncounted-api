// ── PII 구간 유효성 검사 단위 테스트 ──────────────────────────────────────────
import { describe, it, expect } from 'vitest'

import { validatePiiInterval, validatePiiIntervals } from './admin-utterances-helpers.js'

describe('validatePiiInterval', () => {
  it('유효한 구간: 정상 반환', () => {
    const result = validatePiiInterval({ startSec: 1.0, endSec: 3.5, maskType: 'beep', piiType: 'name' })
    expect(result).toBeNull()
  })

  it('startSec이 Infinity이면 에러 반환', () => {
    const result = validatePiiInterval({ startSec: Infinity, endSec: 3.5, maskType: 'beep', piiType: 'name' })
    expect(result).toMatch(/finite/)
  })

  it('endSec이 NaN이면 에러 반환', () => {
    const result = validatePiiInterval({ startSec: 1.0, endSec: NaN, maskType: 'beep', piiType: 'name' })
    expect(result).toMatch(/finite/)
  })

  it('endSec === startSec이면 에러 반환', () => {
    const result = validatePiiInterval({ startSec: 2.0, endSec: 2.0, maskType: 'beep', piiType: 'name' })
    expect(result).toMatch(/endSec must be greater/)
  })

  it('endSec < startSec이면 에러 반환 (음수 duration 방지)', () => {
    const result = validatePiiInterval({ startSec: 5.0, endSec: 3.0, maskType: 'silence', piiType: 'phone' })
    expect(result).toMatch(/endSec must be greater/)
  })

  it('maskType이 string이 아니면 에러 반환', () => {
    const result = validatePiiInterval({ startSec: 1.0, endSec: 2.0, maskType: 123 as unknown as string, piiType: 'name' })
    expect(result).toMatch(/maskType and piiType must be strings/)
  })

  it('piiType이 string이 아니면 에러 반환', () => {
    const result = validatePiiInterval({ startSec: 1.0, endSec: 2.0, maskType: 'beep', piiType: null as unknown as string })
    expect(result).toMatch(/maskType and piiType must be strings/)
  })

  it('startSec이 0이어도 유효', () => {
    const result = validatePiiInterval({ startSec: 0, endSec: 1.0, maskType: 'silence', piiType: 'name' })
    expect(result).toBeNull()
  })

  it('piiDetail은 선택적이며 없어도 유효', () => {
    const result = validatePiiInterval({ startSec: 1.0, endSec: 2.0, maskType: 'beep', piiType: 'name' })
    expect(result).toBeNull()
  })
})

describe('validatePiiIntervals', () => {
  it('빈 배열은 유효 (PII 없음)', () => {
    const result = validatePiiIntervals([])
    expect(result).toBeNull()
  })

  it('모든 구간이 유효하면 null 반환', () => {
    const intervals = [
      { startSec: 0, endSec: 1.0, maskType: 'beep', piiType: 'name' },
      { startSec: 5.0, endSec: 7.5, maskType: 'silence', piiType: 'phone' },
    ]
    const result = validatePiiIntervals(intervals)
    expect(result).toBeNull()
  })

  it('첫 번째 유효하지 않은 구간의 에러 메시지 반환', () => {
    const intervals = [
      { startSec: 0, endSec: 1.0, maskType: 'beep', piiType: 'name' },
      { startSec: 3.0, endSec: 2.0, maskType: 'beep', piiType: 'name' }, // 역순
    ]
    const result = validatePiiIntervals(intervals)
    expect(result).toMatch(/endSec must be greater/)
  })

  it('배열이 아니면 에러 반환', () => {
    const result = validatePiiIntervals(null as unknown as Array<unknown>)
    expect(result).toMatch(/must be an array/)
  })
})
