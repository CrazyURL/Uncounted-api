import { describe, it, expect } from 'vitest'

import { parseNameDenylist, maskKnownNames, NAME_MASK_TOKEN } from './piiNameMask.js'

// NOTE: 이 테스트는 가짜 이름만 사용한다. 실명은 소스/테스트 어디에도 넣지 않는다.
// 운영 denylist 는 PII_NAME_DENYLIST env 로만 주입된다.
const FAKE = '홍길동'
const FAKE2 = '성춘향'

describe('parseNameDenylist', () => {
  it('콤마 구분 문자열을 trim·공백제거하여 배열로 파싱한다', () => {
    expect(parseNameDenylist('홍길동, 성춘향 ,,')).toEqual(['홍길동', '성춘향'])
  })

  it('빈/미정의 입력은 빈 배열을 반환한다', () => {
    expect(parseNameDenylist('')).toEqual([])
    expect(parseNameDenylist(undefined)).toEqual([])
    expect(parseNameDenylist('   ')).toEqual([])
  })

  it('중복은 제거한다', () => {
    expect(parseNameDenylist('홍길동,홍길동,성춘향')).toEqual(['홍길동', '성춘향'])
  })
})

describe('maskKnownNames', () => {
  it('denylist 가 비면 입력을 그대로 반환한다 (no-op, 회귀 0)', () => {
    const text = `메일은 ${FAKE} 소장님 이름을 보내줘`
    expect(maskKnownNames(text, [])).toBe(text)
  })

  it('빈/널 텍스트는 그대로 반환한다', () => {
    expect(maskKnownNames('', [FAKE])).toBe('')
    expect(maskKnownNames(null as unknown as string, [FAKE])).toBe(null)
  })

  it('이름을 토큰으로 치환하고 접미(소장님)는 보존한다', () => {
    expect(maskKnownNames(`메일은 ${FAKE} 소장님 이름을 보내줘`, [FAKE])).toBe(
      `메일은 ${NAME_MASK_TOKEN} 소장님 이름을 보내줘`,
    )
  })

  it('한 문장 내 다중 등장을 모두 치환한다', () => {
    expect(maskKnownNames(`${FAKE}? 아 ${FAKE}님 말이죠`, [FAKE])).toBe(
      `${NAME_MASK_TOKEN}? 아 ${NAME_MASK_TOKEN}님 말이죠`,
    )
  })

  it('다중 이름을 모두 치환한다', () => {
    expect(maskKnownNames(`${FAKE}와 ${FAKE2}`, [FAKE, FAKE2])).toBe(
      `${NAME_MASK_TOKEN}와 ${NAME_MASK_TOKEN}`,
    )
  })

  it('띄어쓰기 변형(문 식환 형태)도 매칭한다', () => {
    // denylist 는 공백 없는 표준형, 입력엔 글자 사이 공백
    const spaced = FAKE.split('').join(' ') // '홍 길 동'
    expect(maskKnownNames(`그건 ${spaced} 소장`, [FAKE])).toBe(
      `그건 ${NAME_MASK_TOKEN} 소장`,
    )
  })

  it('denylist 에 없는 이름은 건드리지 않는다', () => {
    const text = `${FAKE2} 소장님`
    expect(maskKnownNames(text, [FAKE])).toBe(text)
  })

  it('denylist 인자 생략 시 PII_NAME_DENYLIST env 를 읽는다', () => {
    const prev = process.env.PII_NAME_DENYLIST
    process.env.PII_NAME_DENYLIST = FAKE
    try {
      expect(maskKnownNames(`${FAKE} 소장님`)).toBe(`${NAME_MASK_TOKEN} 소장님`)
    } finally {
      if (prev === undefined) delete process.env.PII_NAME_DENYLIST
      else process.env.PII_NAME_DENYLIST = prev
    }
  })
})
