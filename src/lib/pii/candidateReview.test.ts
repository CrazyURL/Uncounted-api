import { describe, it, expect } from 'vitest'
import {
  buildSnippet,
  isValidDecision,
  buildDecisionUpdate,
  CONTEXT_CHARS,
} from './candidateReview.js'

// 모든 이름/문장은 가짜(테스트 픽스처)다.
describe('buildSnippet', () => {
  it('문장 중간 후보 → 앞뒤 컨텍스트 + 정확한 highlight 오프셋', () => {
    const t = '어제 김철수 과장님께 전화했어요'
    const start = 3 // '김철수'
    const end = 6
    const s = buildSnippet(t, start, end, 5)
    expect(s).not.toBeNull()
    expect(s!.candidate_text).toBe('김철수')
    expect(s!.context_before).toBe('어제 ')
    expect(s!.context_after).toBe(' 과장님께')
    expect(s!.snippet).toBe('어제 김철수 과장님께')
    expect(s!.highlight_start).toBe(s!.context_before.length)
    expect(s!.highlight_end).toBe(s!.context_before.length + 3)
    expect(s!.snippet.slice(s!.highlight_start, s!.highlight_end)).toBe('김철수')
  })

  it('문장 시작 후보 → context_before 빈 문자열', () => {
    const t = '홍길동 안녕하세요'
    const s = buildSnippet(t, 0, 3, 10)
    expect(s!.context_before).toBe('')
    expect(s!.candidate_text).toBe('홍길동')
    expect(s!.highlight_start).toBe(0)
    expect(s!.highlight_end).toBe(3)
  })

  it('문장 끝 후보 → context_after 빈 문자열', () => {
    const t = '담당자는 이영희'
    const s = buildSnippet(t, 5, 8, 10)
    expect(s!.candidate_text).toBe('이영희')
    expect(s!.context_after).toBe('')
    expect(s!.snippet.endsWith('이영희')).toBe(true)
  })

  it('contextChars 만큼만 앞뒤를 자른다', () => {
    const t = '0123456789ABC홍길동XYZ9876543210'
    const start = t.indexOf('홍길동')
    const end = start + 3
    const s = buildSnippet(t, start, end, 3)
    expect(s!.context_before).toBe('ABC')
    expect(s!.context_after).toBe('XYZ')
    expect(s!.candidate_text).toBe('홍길동')
  })

  it('기본 contextChars 적용(인자 생략)', () => {
    const t = 'x'.repeat(40) + '김민수' + 'y'.repeat(40)
    const start = 40
    const end = 43
    const s = buildSnippet(t, start, end)
    expect(s!.context_before.length).toBe(CONTEXT_CHARS)
    expect(s!.context_after.length).toBe(CONTEXT_CHARS)
  })

  it('text 가 null/empty 면 null', () => {
    expect(buildSnippet(null, 0, 3)).toBeNull()
    expect(buildSnippet(undefined, 0, 3)).toBeNull()
    expect(buildSnippet('', 0, 3)).toBeNull()
  })

  it('offset 이 null 이면 null', () => {
    expect(buildSnippet('홍길동', null, 3)).toBeNull()
    expect(buildSnippet('홍길동', 0, null)).toBeNull()
    expect(buildSnippet('홍길동', undefined, undefined)).toBeNull()
  })

  it('start >= end 면 null', () => {
    expect(buildSnippet('홍길동', 3, 3)).toBeNull()
    expect(buildSnippet('홍길동', 3, 1)).toBeNull()
  })

  it('offset 이 길이를 초과하면 클램프 후 처리(없으면 null)', () => {
    const t = '홍길동'
    // start 가 길이 이상 → 클램프 후 start>=end → null
    expect(buildSnippet(t, 5, 10)).toBeNull()
    // end 만 초과 → 클램프되어 후보 유지
    const s = buildSnippet(t, 0, 99, 5)
    expect(s!.candidate_text).toBe('홍길동')
    expect(s!.context_after).toBe('')
  })

  it('전체 transcript 를 반환하지 않는다(긴 문장에서 스니펫 길이 제한)', () => {
    const long = '가'.repeat(500) + '홍길동' + '나'.repeat(500)
    const start = 500
    const s = buildSnippet(long, start, start + 3, 15)
    // snippet 길이 = 앞 15 + 후보 3 + 뒤 15 = 33 <<< 1003
    expect(s!.snippet.length).toBe(33)
    expect(s!.snippet.length).toBeLessThan(long.length)
  })
})

describe('isValidDecision', () => {
  it('허용 값은 true', () => {
    expect(isValidDecision('confirmed')).toBe(true)
    expect(isValidDecision('rejected')).toBe(true)
    expect(isValidDecision('skipped')).toBe(true)
  })

  it('미허용/타입 불일치는 false', () => {
    expect(isValidDecision('corrected')).toBe(false) // 본 API 미노출
    expect(isValidDecision('confirm')).toBe(false)
    expect(isValidDecision('')).toBe(false)
    expect(isValidDecision(undefined)).toBe(false)
    expect(isValidDecision(null)).toBe(false)
    expect(isValidDecision(1)).toBe(false)
  })
})

describe('buildDecisionUpdate', () => {
  it('필드 매핑 + status=decided', () => {
    const row = buildDecisionUpdate('confirmed', '이름', 'admin-uid', '2026-05-24T00:00:00.000Z')
    expect(row).toEqual({
      admin_decision: 'confirmed',
      admin_selected_type: '이름',
      reviewed_by: 'admin-uid',
      decided_at: '2026-05-24T00:00:00.000Z',
      status: 'decided',
    })
  })

  it('selected_type 미지정 시 null', () => {
    const row = buildDecisionUpdate('rejected', null, 'admin-uid', '2026-05-24T00:00:00.000Z')
    expect(row.admin_selected_type).toBeNull()
    expect(row.admin_decision).toBe('rejected')
  })

  it("decision 을 그대로 저장하고 'corrected' 로 자동 파생하지 않는다", () => {
    // selected_type 이 predicted 와 달라도 decision 은 'confirmed' 유지
    const row = buildDecisionUpdate('confirmed', '전화번호', 'admin-uid', '2026-05-24T00:00:00.000Z')
    expect(row.admin_decision).toBe('confirmed')
    expect(row.admin_selected_type).toBe('전화번호')
  })
})
