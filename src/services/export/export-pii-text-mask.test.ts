/**
 * PR-δ — export-builder 의 시간기반 PII 텍스트 마스킹 회귀 테스트.
 *
 * detector 가 산출한 pii_intervals(startSec/endSec/piiType)와 transcript_words 의
 * word 시간을 매칭해, 외부 ZIP 텍스트의 해당 단어를 토큰으로 치환하는지 검증.
 * DB 없이 순수 헬퍼만 호출(s3/supabase mock 으로 import 안전망).
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/s3.js', () => ({
  s3Client: { send: vi.fn() },
  S3_AUDIO_BUCKET: 'test-bucket',
}))
vi.mock('../../lib/supabase.js', () => ({ supabaseAdmin: {} }))

import { _testInternals } from './export-builder.js'

const { maskTextByPiiIntervals, buildCallTxt, buildUtteranceLine } = _testInternals as {
  maskTextByPiiIntervals: (u: Record<string, unknown>) => string
  buildCallTxt: (us: Record<string, unknown>[]) => string
  buildUtteranceLine: (u: Record<string, unknown>, sid: string) => Record<string, unknown>
}

function utt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'utt_x_001',
    session_id: 's',
    sequence_order: 1,
    speaker_id: 'SPEAKER_01',
    start_sec: 0,
    end_sec: 5,
    transcript_text: '서버 IP는 10.45.55.177 입니다',
    transcript_words: [
      { word: '서버', start: 0.0, end: 0.5, speaker: 'SPEAKER_01' },
      { word: 'IP는', start: 0.6, end: 1.0, speaker: 'SPEAKER_01' },
      { word: '10.45.55.177', start: 1.1, end: 2.0, speaker: 'SPEAKER_01' },
      { word: '입니다', start: 2.1, end: 2.6, speaker: 'SPEAKER_01' },
    ],
    pii_intervals: [
      { startSec: 1.1, endSec: 2.0, piiType: 'IP주소', maskType: 'text_only' },
    ],
    ...over,
  }
}

describe('PR-δ: maskTextByPiiIntervals', () => {
  it('IP 구간 word 를 [IP] 토큰으로 치환', () => {
    const out = maskTextByPiiIntervals(utt())
    expect(out).toContain('[IP]')
    expect(out).not.toContain('10.45.55.177')   // 평문 IP 미노출
    expect(out).toContain('서버')                 // 비-PII word 보존
    expect(out).toContain('입니다')
  })

  it('이름 piiType 은 [이름] 토큰', () => {
    const out = maskTextByPiiIntervals(utt({
      transcript_text: '저는 이진석 입니다',
      transcript_words: [
        { word: '저는', start: 0.0, end: 0.5 },
        { word: '이진석', start: 0.6, end: 1.2 },
        { word: '입니다', start: 1.3, end: 1.8 },
      ],
      pii_intervals: [{ startSec: 0.6, endSec: 1.2, piiType: '이름', maskType: 'text_only' }],
    }))
    expect(out).toContain('[이름]')
    expect(out).not.toContain('이진석')
  })

  it('pii_intervals 없으면 원본 그대로 (회귀 없음)', () => {
    const out = maskTextByPiiIntervals(utt({ pii_intervals: [] }))
    expect(out).toBe('서버 IP는 10.45.55.177 입니다')
  })

  it('transcript_words 없으면 원본 그대로 (마스킹 불가 시 안전)', () => {
    const out = maskTextByPiiIntervals(utt({ transcript_words: null }))
    expect(out).toBe('서버 IP는 10.45.55.177 입니다')
  })

  it('빈 transcript_text 는 빈 문자열', () => {
    expect(maskTextByPiiIntervals(utt({ transcript_text: '' }))).toBe('')
  })

  it('겹치지 않는 interval 은 마스킹 안 함', () => {
    const out = maskTextByPiiIntervals(utt({
      pii_intervals: [{ startSec: 10.0, endSec: 11.0, piiType: 'IP주소', maskType: 'text_only' }],
    }))
    expect(out).toContain('10.45.55.177')   // 시간 안 겹침 → 원본 유지
  })

  it('알 수 없는 piiType 은 [PII] 토큰', () => {
    const out = maskTextByPiiIntervals(utt({
      pii_intervals: [{ startSec: 1.1, endSec: 2.0, piiType: '미지', maskType: 'text_only' }],
    }))
    expect(out).toContain('[PII]')
    expect(out).not.toContain('10.45.55.177')
  })
})

describe('PR-δ: buildCallTxt / buildUtteranceLine 마스킹 통합', () => {
  it('buildCallTxt 출력에 평문 PII 없음', () => {
    const txt = buildCallTxt([utt()])
    expect(txt).toContain('[SPEAKER_01]')
    expect(txt).toContain('[IP]')
    expect(txt).not.toContain('10.45.55.177')
  })

  it('buildUtteranceLine.text 에 평문 PII 없음', () => {
    const line = buildUtteranceLine(utt(), 's')
    expect(String(line.text)).toContain('[IP]')
    expect(String(line.text)).not.toContain('10.45.55.177')
  })

  it('PII 없는 발화는 buildCallTxt 원본 보존 (회귀)', () => {
    const clean = utt({
      transcript_text: '안녕하세요 반갑습니다',
      transcript_words: [
        { word: '안녕하세요', start: 0, end: 1 },
        { word: '반갑습니다', start: 1.1, end: 2 },
      ],
      pii_intervals: [],
    })
    const txt = buildCallTxt([clean])
    expect(txt).toBe('[SPEAKER_01] 안녕하세요 반갑습니다')
  })
})
