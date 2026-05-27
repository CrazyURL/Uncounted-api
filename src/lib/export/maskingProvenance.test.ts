// D4b-3: pii_meta.maskingMethod provenance — text_only 패키지가 audio_beep_1khz 로 오표기되지 않도록.
// 순수 함수 단위 테스트(supabase env 불요).
import { describe, it, expect } from 'vitest'
import { collectMaskTypeDistribution, deriveMaskingMethod } from './maskingProvenance.js'

describe('deriveMaskingMethod (PII masking provenance)', () => {
  it('text_only 만 있는 패키지는 audio_beep_1khz 를 주장하지 않는다', () => {
    const method = deriveMaskingMethod(['text_only'])
    expect(method).toBe('text_substitute')
    expect(method).not.toContain('audio')
  })

  it('실제 audio(beep) maskType 이 있을 때만 audio_beep_1khz 표기', () => {
    expect(deriveMaskingMethod(['beep'])).toBe('audio_beep_1khz + text_substitute')
    expect(deriveMaskingMethod(['audio_beep_1khz'])).toBe('audio_beep_1khz + text_substitute')
    // legacy alias 'audio' 방어(현 live writer 없음)
    expect(deriveMaskingMethod(['audio'])).toBe('audio_beep_1khz + text_substitute')
  })

  it('silence maskType 은 audio_silence 로 표기(audio_beep_1khz 아님)', () => {
    const method = deriveMaskingMethod(['silence'])
    expect(method).toBe('audio_silence + text_substitute')
    expect(method).not.toContain('audio_beep_1khz')
  })

  it('mixed 패키지는 실재 토큰만 표기하고 과장하지 않는다', () => {
    // beep + text_only → audio_beep_1khz 는 실재(일부 구간) → 표기 정당, text_substitute 동반
    expect(deriveMaskingMethod(['text_only', 'beep'])).toBe('audio_beep_1khz + text_substitute')
    // beep + silence → 둘 다 실재
    expect(deriveMaskingMethod(['beep', 'silence'])).toBe(
      'audio_beep_1khz + audio_silence + text_substitute',
    )
  })

  it('PII 구간이 전무하면 text_substitute 만(음향 주장 없음)', () => {
    const method = deriveMaskingMethod([])
    expect(method).toBe('text_substitute')
    expect(method).not.toContain('audio')
  })

  it('unknown maskType 은 음향 토큰을 만들지 않는다', () => {
    expect(deriveMaskingMethod(['mystery'])).toBe('text_substitute')
  })
})

describe('collectMaskTypeDistribution', () => {
  it('utterances 전반의 maskType 카운트를 집계한다', () => {
    const utterances = [
      { pii_intervals: [{ maskType: 'text_only' }, { maskType: 'text_only' }] },
      { pii_intervals: [{ maskType: 'beep' }] },
      { pii_intervals: null },
      { pii_intervals: 'not-an-array' },
      {},
    ]
    expect(collectMaskTypeDistribution(utterances)).toEqual({ text_only: 2, beep: 1 })
  })

  it('PII 구간이 없으면 빈 분포', () => {
    expect(collectMaskTypeDistribution([{ pii_intervals: [] }, {}])).toEqual({})
  })

  it('분포 키로 maskingMethod 가 정직하게 산출된다(통합)', () => {
    const dist = collectMaskTypeDistribution([{ pii_intervals: [{ maskType: 'text_only' }] }])
    expect(deriveMaskingMethod(Object.keys(dist))).toBe('text_substitute')
  })
})
