import { describe, it, expect } from 'vitest'
import { extractUtteranceForm } from './utterance-form.js'

describe('extractUtteranceForm', () => {
  it('returns unknown shape for empty/non-string input', () => {
    const result = extractUtteranceForm('')
    expect(result.utterance_type).toBe('unknown')
    expect(result.turn_type).toBe('unknown')
    expect(result.is_short_response).toBe(false)
    expect(result.is_backchannel).toBe(false)
    expect(result.is_greeting).toBe(false)
    expect(result.is_closing).toBe(false)
  })

  it('detects question marker (?)', () => {
    expect(extractUtteranceForm('어디 가시나요?').utterance_type).toBe('question')
    expect(extractUtteranceForm('도와드릴까요').utterance_type).toBe('question')
  })

  it('detects exclamation', () => {
    expect(extractUtteranceForm('정말 좋네요!').utterance_type).toBe('exclamation')
  })

  it('detects statement', () => {
    expect(extractUtteranceForm('네 알겠습니다.').utterance_type).toBe('statement')
    expect(extractUtteranceForm('확인했어요').utterance_type).toBe('statement')
  })

  it('detects short response (stripped length <= 4 chars)', () => {
    expect(extractUtteranceForm('네').is_short_response).toBe(true)
    expect(extractUtteranceForm('네 알겠어요').is_short_response).toBe(false)
    expect(extractUtteranceForm('알겠습니다 감사합니다').is_short_response).toBe(false)
  })

  it('detects backchannel tokens', () => {
    expect(extractUtteranceForm('응').is_backchannel).toBe(true)
    expect(extractUtteranceForm('네네').is_backchannel).toBe(true)
    expect(extractUtteranceForm('알겠습니다 감사합니다').is_backchannel).toBe(false)
  })

  it('detects greeting', () => {
    expect(extractUtteranceForm('안녕하세요 반갑습니다').is_greeting).toBe(true)
    expect(extractUtteranceForm('Hello there').is_greeting).toBe(true)
    expect(extractUtteranceForm('네 알겠어요').is_greeting).toBe(false)
  })

  it('detects closing', () => {
    expect(extractUtteranceForm('안녕히 가세요').is_closing).toBe(true)
    expect(extractUtteranceForm('수고하세요').is_closing).toBe(true)
    expect(extractUtteranceForm('네 알겠어요').is_closing).toBe(false)
  })

  it('detects turn_type from context', () => {
    expect(
      extractUtteranceForm('안녕하세요', { sequence_order: 0, total_utterances: 10 }).turn_type,
    ).toBe('opening')
    expect(
      extractUtteranceForm('네', { sequence_order: 5, total_utterances: 10 }).turn_type,
    ).toBe('mid')
    expect(
      extractUtteranceForm('감사합니다', { sequence_order: 9, total_utterances: 10 }).turn_type,
    ).toBe('closing')
    expect(
      extractUtteranceForm('네', { sequence_order: 0, total_utterances: 0 }).turn_type,
    ).toBe('unknown')
  })

  it('returns only the documented schema fields', () => {
    const result = extractUtteranceForm('테스트')
    const keys = Object.keys(result).sort()
    expect(keys).toEqual(
      [
        'is_backchannel',
        'is_closing',
        'is_greeting',
        'is_short_response',
        'turn_type',
        'utterance_type',
      ].sort(),
    )
  })
})
