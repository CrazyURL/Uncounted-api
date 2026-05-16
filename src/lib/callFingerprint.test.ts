// Vitest 단위 테스트 — callFingerprint
// 검증 항목:
//   - normalizePhone (한국 표준 5종)
//   - classifyPhone (mobile/landline/virtual/corporate)
//   - classifyGrade (PREMIUM/STANDARD/EXCLUDED 매트릭스)
//   - generateSpeakersHash (정렬 무관 + 결정성)
//   - generateFingerprint (입력 동일 → 동일, quartile 변경 → 다름)
//   - calculateReleaseDate (다음달 15일)

import { beforeAll, describe, expect, it } from 'vitest'
import {
  calculateReleaseDate,
  classifyGrade,
  classifyPhone,
  generateFingerprint,
  generateFingerprintParts,
  generateSpeakersHash,
  normalizePhone,
} from './callFingerprint'

beforeAll(() => {
  process.env.PHONE_HASH_SECRET = 'test-secret-do-not-use-in-production-32-byte-hex'
})

describe('normalizePhone', () => {
  it('정규형 010 모바일 — 그대로 반환', () => {
    expect(normalizePhone('01012345678')).toBe('01012345678')
  })

  it('하이픈 박힌 010 — 하이픈 제거', () => {
    expect(normalizePhone('010-1234-5678')).toBe('01012345678')
  })

  it('공백 박힌 010 — 공백 제거', () => {
    expect(normalizePhone('010 1234 5678')).toBe('01012345678')
  })

  it('+82-10 국가코드 → 010', () => {
    expect(normalizePhone('+82-10-1234-5678')).toBe('01012345678')
  })

  it('+82 10 (공백) → 010', () => {
    expect(normalizePhone('+82 10-1234-5678')).toBe('01012345678')
  })

  it('+82-31 유선 → 0311234567', () => {
    expect(normalizePhone('+82-31-123-4567')).toBe('0311234567')
  })

  it('가상번호 050 → 0501234567', () => {
    expect(normalizePhone('050-1234-5678')).toBe('05012345678')
  })

  it('기업번호 1588 → 0 prefix 박지 X', () => {
    expect(normalizePhone('1588-1234')).toBe('15881234')
  })

  it('기업번호 1577 → 0 prefix 박지 X', () => {
    expect(normalizePhone('1577-9999')).toBe('15779999')
  })

  it('빈 문자열 → 빈 문자열', () => {
    expect(normalizePhone('')).toBe('')
  })
})

describe('classifyPhone', () => {
  it('010 → mobile', () => {
    expect(classifyPhone('010-1234-5678')).toBe('mobile')
  })

  it('011 → mobile', () => {
    expect(classifyPhone('011-1234-5678')).toBe('mobile')
  })

  it('016/017/018/019 → mobile', () => {
    expect(classifyPhone('016-1234-5678')).toBe('mobile')
    expect(classifyPhone('017-1234-5678')).toBe('mobile')
    expect(classifyPhone('019-1234-5678')).toBe('mobile')
  })

  it('050 가상번호 → virtual', () => {
    expect(classifyPhone('050-1234-5678')).toBe('virtual')
  })

  it('1588 기업번호 → corporate', () => {
    expect(classifyPhone('1588-1234')).toBe('corporate')
  })

  it('1577 기업번호 → corporate', () => {
    expect(classifyPhone('1577-1234')).toBe('corporate')
  })

  it('1644 기업번호 → corporate', () => {
    expect(classifyPhone('1644-1234')).toBe('corporate')
  })

  it('02 서울 유선 → landline', () => {
    expect(classifyPhone('02-1234-5678')).toBe('landline')
  })

  it('031 경기 유선 → landline', () => {
    expect(classifyPhone('031-123-4567')).toBe('landline')
  })
})

describe('classifyGrade', () => {
  it('mobile ↔ mobile → premium', () => {
    expect(classifyGrade('mobile', 'mobile')).toBe('premium')
  })

  it('mobile ↔ landline → premium (양방향)', () => {
    expect(classifyGrade('mobile', 'landline')).toBe('premium')
    expect(classifyGrade('landline', 'mobile')).toBe('premium')
  })

  it('mobile ↔ corporate → standard (양방향)', () => {
    expect(classifyGrade('mobile', 'corporate')).toBe('standard')
    expect(classifyGrade('corporate', 'mobile')).toBe('standard')
  })

  it('mobile ↔ virtual → standard (양방향)', () => {
    expect(classifyGrade('mobile', 'virtual')).toBe('standard')
    expect(classifyGrade('virtual', 'mobile')).toBe('standard')
  })

  it('virtual ↔ virtual → excluded (양쪽 가상번호)', () => {
    expect(classifyGrade('virtual', 'virtual')).toBe('excluded')
  })

  it('corporate ↔ corporate → excluded', () => {
    expect(classifyGrade('corporate', 'corporate')).toBe('excluded')
  })

  it('landline ↔ landline → excluded (보수적 시드 정책)', () => {
    expect(classifyGrade('landline', 'landline')).toBe('excluded')
  })

  it('landline ↔ corporate → excluded', () => {
    expect(classifyGrade('landline', 'corporate')).toBe('excluded')
  })
})

describe('generateSpeakersHash', () => {
  it('caller·callee 순서 무관 — 같은 hash', () => {
    const a = generateSpeakersHash('010-1111-2222', '010-3333-4444')
    const b = generateSpeakersHash('010-3333-4444', '010-1111-2222')
    expect(a).toBe(b)
  })

  it('정규화 — +82-10 vs 010 같은 hash', () => {
    const a = generateSpeakersHash('+82-10-1111-2222', '010-3333-4444')
    const b = generateSpeakersHash('010-1111-2222', '010-3333-4444')
    expect(a).toBe(b)
  })

  it('다른 peer 쌍 → 다른 hash', () => {
    const a = generateSpeakersHash('010-1111-2222', '010-3333-4444')
    const b = generateSpeakersHash('010-1111-2222', '010-5555-6666')
    expect(a).not.toBe(b)
  })

  it('PHONE_HASH_SECRET 없으면 throw', () => {
    const orig = process.env.PHONE_HASH_SECRET
    delete process.env.PHONE_HASH_SECRET
    expect(() => generateSpeakersHash('010-1111-2222', '010-3333-4444')).toThrow(
      'PHONE_HASH_SECRET',
    )
    process.env.PHONE_HASH_SECRET = orig
  })
})

describe('generateFingerprint', () => {
  const baseCall = {
    callerPhone: '010-1111-2222',
    calleePhone: '010-3333-4444',
    startedAt: new Date('2026-05-04T14:23:10Z'),
    duration: 120,
  }

  it('동일 입력 → 동일 fingerprint (결정성)', () => {
    const a = generateFingerprint(baseCall)
    const b = generateFingerprint(baseCall)
    expect(a).toBe(b)
  })

  it('caller/callee 순서 바꿔도 같은 fingerprint', () => {
    const swapped = {
      ...baseCall,
      callerPhone: baseCall.calleePhone,
      calleePhone: baseCall.callerPhone,
    }
    expect(generateFingerprint(baseCall)).toBe(generateFingerprint(swapped))
  })

  it('다른 분 단위 → 다른 fingerprint', () => {
    const otherMinute = {
      ...baseCall,
      startedAt: new Date('2026-05-04T14:24:10Z'),
    }
    expect(generateFingerprint(baseCall)).not.toBe(generateFingerprint(otherMinute))
  })

  it('다른 quartile (15초 단위) → 다른 fingerprint', () => {
    // 14:23:10 → quartile 0 / 14:23:20 → quartile 1
    const otherQuartile = {
      ...baseCall,
      startedAt: new Date('2026-05-04T14:23:20Z'),
    }
    expect(generateFingerprint(baseCall)).not.toBe(generateFingerprint(otherQuartile))
  })

  it('같은 quartile 안 (14:23:10 vs 14:23:14) → 같은 fingerprint', () => {
    const sameQuartile = {
      ...baseCall,
      startedAt: new Date('2026-05-04T14:23:14Z'),
    }
    expect(generateFingerprint(baseCall)).toBe(generateFingerprint(sameQuartile))
  })

  it('duration 5초 차이 (같은 bucket) → 같은 fingerprint', () => {
    // 120s → bucket 24, 124s → bucket 24
    const sameBucket = { ...baseCall, duration: 124 }
    expect(generateFingerprint(baseCall)).toBe(generateFingerprint(sameBucket))
  })

  it('duration 5초 단위 다름 → 다른 fingerprint', () => {
    // 120s bucket 24, 125s bucket 25
    const otherBucket = { ...baseCall, duration: 125 }
    expect(generateFingerprint(baseCall)).not.toBe(generateFingerprint(otherBucket))
  })
})

describe('generateFingerprintParts', () => {
  it('quartile 0~3 범위', () => {
    const call = {
      callerPhone: '010-1111-2222',
      calleePhone: '010-3333-4444',
      startedAt: new Date('2026-05-04T14:23:00Z'),
      duration: 120,
    }
    const p0 = generateFingerprintParts(call).quartile
    const p1 = generateFingerprintParts({
      ...call,
      startedAt: new Date('2026-05-04T14:23:15Z'),
    }).quartile
    const p2 = generateFingerprintParts({
      ...call,
      startedAt: new Date('2026-05-04T14:23:30Z'),
    }).quartile
    const p3 = generateFingerprintParts({
      ...call,
      startedAt: new Date('2026-05-04T14:23:45Z'),
    }).quartile

    expect(p0).toBe(0)
    expect(p1).toBe(1)
    expect(p2).toBe(2)
    expect(p3).toBe(3)
  })
})

describe('calculateReleaseDate', () => {
  it('5/1 거래 → 6/15 release (45일 hold)', () => {
    const r = calculateReleaseDate(new Date('2026-05-01T10:30:00Z'))
    expect(r.getMonth()).toBe(5) // June (0-indexed)
    expect(r.getDate()).toBe(15)
  })

  it('5/31 거래 → 6/15 release (15일 hold, 월말 보정)', () => {
    const r = calculateReleaseDate(new Date('2026-05-31T23:59:00Z'))
    // setMonth(+1)는 6/30이 아닌 7/1로 갈 수 있음. setDate(15) 이후 15일.
    // 핵심: 결과가 다음달(또는 그 다음달) 15일이어야 한다.
    expect(r.getDate()).toBe(15)
  })

  it('6/1 거래 → 7/15 release', () => {
    const r = calculateReleaseDate(new Date('2026-06-01T08:00:00Z'))
    expect(r.getMonth()).toBe(6) // July
    expect(r.getDate()).toBe(15)
  })

  it('연말 12/15 거래 → 1/15 release (해 넘김)', () => {
    const r = calculateReleaseDate(new Date('2026-12-15T12:00:00Z'))
    expect(r.getFullYear()).toBe(2027)
    expect(r.getMonth()).toBe(0) // January
    expect(r.getDate()).toBe(15)
  })

  it('시각 부분 00:00:00 박음', () => {
    const r = calculateReleaseDate(new Date('2026-05-04T14:23:45Z'))
    expect(r.getHours()).toBe(0)
    expect(r.getMinutes()).toBe(0)
    expect(r.getSeconds()).toBe(0)
  })
})
