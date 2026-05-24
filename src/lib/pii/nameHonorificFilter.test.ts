import { describe, it, expect } from 'vitest'
import {
  isHonorificAdjacentName,
  filterCandidatesByPrecision,
  NAME_PII_TYPE,
} from './nameHonorificFilter.js'

// 모든 이름 문자열은 가짜(테스트 픽스처)다.
describe('isHonorificAdjacentName', () => {
  it('이름 바로 뒤 "님" → true', () => {
    const t = '홍길동님 안녕하세요'
    expect(isHonorificAdjacentName(t, 0, 3)).toBe(true)
  })

  it('이름 + 공백 + "과장님" → true', () => {
    const t = '김철수 과장님 전화 주세요'
    expect(isHonorificAdjacentName(t, 0, 3)).toBe(true)
  })

  it('이름 + "씨" → true', () => {
    const t = '이영희씨 계신가요'
    expect(isHonorificAdjacentName(t, 0, 3)).toBe(true)
  })

  it('호칭 없는 3자 이름 단독 → false', () => {
    const t = '홍길동 어디 갔어'
    expect(isHonorificAdjacentName(t, 0, 3)).toBe(false)
  })

  it('호칭 없는 2자 이름 단독 → false', () => {
    const t = '민수 왔어'
    expect(isHonorificAdjacentName(t, 0, 2)).toBe(false)
  })

  it('span 자체가 호칭으로 끝나는 경우(탐지기가 호칭 포함) → true', () => {
    const t = '박서준매니저 입니다'
    expect(isHonorificAdjacentName(t, 0, 6)).toBe(true) // '박서준매니저'
  })

  it('span 이 NAME_STOPWORDS 면 → false (호칭이 와도)', () => {
    const t = '안녕하님' // 인위적 케이스: 흔한 표현 + 호칭
    expect(isHonorificAdjacentName(t, 0, 3)).toBe(false)
  })

  it('빈 텍스트/역전 offset → false', () => {
    expect(isHonorificAdjacentName('', 0, 3)).toBe(false)
    expect(isHonorificAdjacentName('홍길동', 3, 1)).toBe(false)
    expect(isHonorificAdjacentName('홍길동', 0, 99)).toBe(false)
  })
})

describe('filterCandidatesByPrecision', () => {
  it('구조 PII(비-이름)는 호칭 무관 항상 통과', () => {
    const t = '제 번호는 010-1234-5678 입니다'
    const cands = [{ type: '전화번호', char_start: 6, char_end: 19 }]
    expect(filterCandidatesByPrecision(cands, t)).toHaveLength(1)
  })

  it('이름 후보: 호칭 동반만 남고 단독은 드롭', () => {
    const t = '홍길동 과장님과 김영수 그리고 010-1234-5678'
    const cands = [
      { type: NAME_PII_TYPE, char_start: 0, char_end: 3 }, // 홍길동 + 과장님 → keep
      { type: NAME_PII_TYPE, char_start: 9, char_end: 12 }, // 김영수 단독 → drop
      { type: '전화번호', char_start: 19, char_end: 32 }, // 통과
    ]
    const kept = filterCandidatesByPrecision(cands, t)
    expect(kept).toHaveLength(2)
    expect(kept.some((c) => c.type === NAME_PII_TYPE && c.char_start === 0)).toBe(true)
    expect(kept.some((c) => c.type === NAME_PII_TYPE && c.char_start === 9)).toBe(false)
    expect(kept.some((c) => c.type === '전화번호')).toBe(true)
  })

  it('빈 후보 → 빈 배열', () => {
    expect(filterCandidatesByPrecision([], '아무 텍스트')).toEqual([])
  })
})
