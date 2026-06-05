import { describe, it, expect } from 'vitest'
import { validateDeliveryRecords, DELIVERY_RECORD_SCHEMA } from './delivery-schema.js'

const valid = {
  utterance_id: 'utt_1',
  session_id: 's1',
  sequence_order: 0,
  start_sec: 0,
  end_sec: 1.5,
  duration_sec: 1.5,
  speaker_label: 'SPEAKER_00',
  speaker_role_candidate: null,
  text: '안녕하세요',
  is_overlapping: false,
}

describe('delivery-schema', () => {
  it('유효 레코드 통과', () => {
    const r = validateDeliveryRecords([valid])
    expect(r.valid).toBe(true)
    expect(r.errorCount).toBe(0)
  })

  it('빈 text(무음 발화) 허용', () => {
    expect(validateDeliveryRecords([{ ...valid, text: '' }]).valid).toBe(true)
  })

  it('nullable 필드 null 허용', () => {
    expect(validateDeliveryRecords([{ ...valid, duration_sec: null, is_overlapping: null }]).valid).toBe(true)
  })

  it('필수 필드 누락 → 위반', () => {
    const { utterance_id, ...noId } = valid
    const r = validateDeliveryRecords([noId])
    expect(r.valid).toBe(false)
    expect(r.errorCount).toBeGreaterThan(0)
  })

  it('잘못된 타입(sequence_order 문자열) → 위반', () => {
    const r = validateDeliveryRecords([{ ...valid, sequence_order: 'zero' }])
    expect(r.valid).toBe(false)
  })

  it('음수 start_sec → 위반', () => {
    expect(validateDeliveryRecords([{ ...valid, start_sec: -1 }]).valid).toBe(false)
  })

  it('추가 필드 허용(미래 호환)', () => {
    expect(validateDeliveryRecords([{ ...valid, extra_future_field: 'x' }]).valid).toBe(true)
  })

  it('레코드별 위치 에러 보고', () => {
    const r = validateDeliveryRecords([valid, { ...valid, speaker_label: '' }])
    expect(r.errors.some((e) => e.startsWith('record[1]'))).toBe(true)
  })

  it('스키마는 draft-07 + $id 발행', () => {
    expect(DELIVERY_RECORD_SCHEMA.$schema).toContain('draft-07')
    expect(DELIVERY_RECORD_SCHEMA.$id).toContain('utterance-delivery-record')
  })
})
