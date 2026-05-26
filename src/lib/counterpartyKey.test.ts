// ── counterpartyKey 테스트 (title 파싱 + 정규화 + 결정적 키) ──────────────
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  parseCounterpartyTitle,
  normalizeCounterpartyId,
  buildCounterpartyKey,
  deriveCounterpartyKeyFromTitle,
  maskedDisplayName,
} from './counterpartyKey.js'

const SECRET = 'test-secret-do-not-use-in-prod'
const USER_A = '00000000-0000-0000-0000-00000000000a'
const USER_B = '00000000-0000-0000-0000-00000000000b'

describe('parseCounterpartyTitle — 접두/접미 제거', () => {
  it('표준 파일명에서 {id} 추출', () => {
    expect(parseCounterpartyTitle('통화 녹음 홍길동_260524_143022')).toBe('홍길동')
  })

  it('접두 공백 없는 "통화녹음" 변형도 매칭', () => {
    expect(parseCounterpartyTitle('통화녹음 홍길동_260524_143022')).toBe('홍길동')
  })

  it("{id}에 '_' 포함 시 마지막 _\\d{6}_\\d{6}에 앵커(중간 보존)", () => {
    expect(parseCounterpartyTitle('통화 녹음 a_b_260524_143022')).toBe('a_b')
  })

  it('{id}가 날짜형 토큰이어도 마지막 접미만 제거', () => {
    expect(parseCounterpartyTitle('통화 녹음 250101_260524_143022')).toBe('250101')
  })

  it('합성 라벨 등 비매칭 title 은 null(스킵)', () => {
    expect(parseCounterpartyTitle('통화#000042 · 2026-05-02 · 30초')).toBeNull()
    expect(parseCounterpartyTitle('녹음 홍길동_260524_143022')).toBeNull()
    expect(parseCounterpartyTitle('통화 녹음 홍길동_2605_1430')).toBeNull()
  })

  it('null/빈 문자열 은 null', () => {
    expect(parseCounterpartyTitle(null)).toBeNull()
    expect(parseCounterpartyTitle(undefined)).toBeNull()
    expect(parseCounterpartyTitle('')).toBeNull()
  })
})

describe('normalizeCounterpartyId — 분류 + 정규화', () => {
  it('전화번호형 → title_phone + normalizePhone + 0.90', () => {
    const r = normalizeCounterpartyId('010-1234-5678')
    expect(r.kind).toBe('title_phone')
    expect(r.normalizedId).toBe('01012345678')
    expect(r.confidence).toBe(0.9)
  })

  it('+82 국제표기도 0 prefix 로 정규화', () => {
    expect(normalizeCounterpartyId('+82 10-1234-5678').normalizedId).toBe('01012345678')
  })

  it('이름형 → title_name + 0.50', () => {
    const r = normalizeCounterpartyId('홍길동')
    expect(r.kind).toBe('title_name')
    expect(r.normalizedId).toBe('홍길동')
    expect(r.confidence).toBe(0.5)
  })

  it('후행 호칭 제거 (님/씨/선생님)', () => {
    expect(normalizeCounterpartyId('문소라님').normalizedId).toBe('문소라')
    expect(normalizeCounterpartyId('홍길동씨').normalizedId).toBe('홍길동')
    expect(normalizeCounterpartyId('김선생님').normalizedId).toBe('김')
  })

  it('내부 공백 1칸 축약 + trim', () => {
    expect(normalizeCounterpartyId('  김  철수 ').normalizedId).toBe('김 철수')
  })
})

describe('buildCounterpartyKey — 결정적·사용자별·kind별 분리', () => {
  it('같은 입력 → 같은 identityHash (결정적)', () => {
    const p = normalizeCounterpartyId('홍길동')
    const k1 = buildCounterpartyKey(USER_A, p, SECRET)
    const k2 = buildCounterpartyKey(USER_A, p, SECRET)
    expect(k1.identityHash).toBe(k2.identityHash)
  })

  it('user 가 다르면 identityHash 다름', () => {
    const p = normalizeCounterpartyId('홍길동')
    expect(buildCounterpartyKey(USER_A, p, SECRET).identityHash).not.toBe(
      buildCounterpartyKey(USER_B, p, SECRET).identityHash,
    )
  })

  it('phone kind: phoneHash = HMAC(secret, normalizedId), name kind: null', () => {
    const phone = buildCounterpartyKey(USER_A, normalizeCounterpartyId('010-1234-5678'), SECRET)
    const expected = createHmac('sha256', SECRET).update('01012345678').digest('hex')
    expect(phone.phoneHash).toBe(expected)

    const name = buildCounterpartyKey(USER_A, normalizeCounterpartyId('홍길동'), SECRET)
    expect(name.phoneHash).toBeNull()
  })

  it('secret 미설정 시 throw', () => {
    expect(() => buildCounterpartyKey(USER_A, normalizeCounterpartyId('홍길동'), '')).toThrow()
  })
})

describe('deriveCounterpartyKeyFromTitle — end-to-end', () => {
  it('유효 title → 키', () => {
    const k = deriveCounterpartyKeyFromTitle(USER_A, '통화 녹음 홍길동_260524_143022', SECRET)
    expect(k).not.toBeNull()
    expect(k?.kind).toBe('title_name')
    expect(k?.confidence).toBe(0.5)
  })

  it('비매칭 title → null (스킵)', () => {
    expect(deriveCounterpartyKeyFromTitle(USER_A, '통화#000042 · 2026-05-02', SECRET)).toBeNull()
  })

  it('정규화 후 빈 문자열(호칭만) → null', () => {
    expect(deriveCounterpartyKeyFromTitle(USER_A, '통화 녹음 님_260524_143022', SECRET)).toBeNull()
  })
})

describe('maskedDisplayName — 비식별 토큰(PII 미포함)', () => {
  it('상대#<hash8> 형식', () => {
    const hash = 'abcdef0123456789'
    expect(maskedDisplayName(hash)).toBe('상대#abcdef01')
  })
})
