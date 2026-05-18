import { describe, it, expect } from 'vitest'
import {
  extractNumericPatterns,
  type NumericPattern,
} from './numeric-patterns.js'

describe('extractNumericPatterns', () => {
  it('returns empty array for empty / non-string input', () => {
    expect(extractNumericPatterns('')).toEqual([])
    expect(extractNumericPatterns(null)).toEqual([])
    expect(extractNumericPatterns(undefined)).toEqual([])
    expect(extractNumericPatterns(12345)).toEqual([])
  })

  it('extracts phone numbers and masks them as [PHONE]', () => {
    const result = extractNumericPatterns('연락처는 010-1234-5678 입니다')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('phone_number')
    expect(result[0].surface_masked).toBe('[PHONE]')
    expect(result[0].normalized_masked).toBe('[PHONE]')
    expect(result[0].pii_related).toBe(true)
  })

  it('extracts birth dates ahead of generic date pattern', () => {
    const result = extractNumericPatterns('생일은 1990년 5월 6일 입니다')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('birth_date')
    expect(result[0].surface_masked).toBe('[BIRTHDATE]')
    expect(result[0].pii_related).toBe(true)
  })

  it('extracts statistics as percent', () => {
    const result = extractNumericPatterns('전년 대비 35% 증가')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('statistics')
    expect(result[0].surface_masked).toBe('[PERCENT]')
    expect(result[0].pii_related).toBe(false)
  })

  it('extracts time pattern', () => {
    const result = extractNumericPatterns('미팅은 14:30 시작')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('time')
  })

  it('extracts multiple patterns in order without overlap', () => {
    const result = extractNumericPatterns(
      '010-1234-5678 로 연락주시면 14:30 에 통화 가능합니다',
    )
    expect(result.map((r) => r.type)).toEqual(['phone_number', 'time'])
  })

  // SAFETY (안전선 #3, #4): returned objects MUST NOT include raw text fields.
  it('NEVER includes surface_text or normalized keys (안전선 #3, #4)', () => {
    const samples = [
      '010-9999-0000 입니다',
      '계좌 110-123-456789 송금',
      '나이는 32세',
      '비율 0.5%',
    ]
    for (const sample of samples) {
      const result = extractNumericPatterns(sample)
      for (const pattern of result) {
        const keys = Object.keys(pattern)
        expect(keys).not.toContain('surface_text')
        expect(keys).not.toContain('normalized')
        expect(keys).toEqual(
          expect.arrayContaining(['type', 'surface_masked', 'normalized_masked', 'pii_related']),
        )
        // surface_masked must be a token form, never contain raw digits
        expect((pattern as NumericPattern).surface_masked).toMatch(/^\[[A-Z_]+\]$/)
        expect((pattern as NumericPattern).normalized_masked).toMatch(/^\[[A-Z_]+\]$/)
      }
    }
  })

  it('handles text without any numeric patterns', () => {
    expect(extractNumericPatterns('안녕하세요 반갑습니다')).toEqual([])
  })
})
