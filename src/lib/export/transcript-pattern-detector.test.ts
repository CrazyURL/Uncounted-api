// transcript-pattern-detector 단위 테스트 — PR-A export safety preflight (P0).
//
// 디렉터 명시: 30+ cases, false positive 방지, multiline, mixed language,
// feature flag false 우회. 단위 테스트는 detector 의 순수성 검증 + 호출자
// (safety-checks.ts) 통합 시 fail-closed throw 검증 (별도 파일).

import { describe, it, expect } from 'vitest'

import {
  detectTranscriptPatterns,
  isSafetyPreflightEnabled,
  totalsConsistent,
  emptyResult,
} from './transcript-pattern-detector.js'

// ─────────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────────

describe('isSafetyPreflightEnabled', () => {
  it('default = true (env 미설정)', () => {
    expect(isSafetyPreflightEnabled({})).toBe(true)
  })

  it("'false' 명시 → 비활성", () => {
    expect(isSafetyPreflightEnabled({ EXPORT_SAFETY_PREFLIGHT_ENABLED: 'false' })).toBe(false)
  })

  it("'true' / 빈문자 / 'no' / 그 외 → 활성 (안전 우선)", () => {
    expect(isSafetyPreflightEnabled({ EXPORT_SAFETY_PREFLIGHT_ENABLED: 'true' })).toBe(true)
    expect(isSafetyPreflightEnabled({ EXPORT_SAFETY_PREFLIGHT_ENABLED: '' })).toBe(true)
    expect(isSafetyPreflightEnabled({ EXPORT_SAFETY_PREFLIGHT_ENABLED: 'no' })).toBe(true)
    expect(isSafetyPreflightEnabled({ EXPORT_SAFETY_PREFLIGHT_ENABLED: '0' })).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 빈/타입 가드
// ─────────────────────────────────────────────────────────────────────────

describe('detectTranscriptPatterns — 빈/타입 입력', () => {
  it('빈 문자열 → totalHits=0', () => {
    const r = detectTranscriptPatterns('')
    expect(r.totalHits).toBe(0)
    expect(totalsConsistent(r)).toBe(true)
  })

  it('non-string 입력 → 빈 결과', () => {
    const r = detectTranscriptPatterns(null as unknown as string)
    expect(r.totalHits).toBe(0)
  })

  it('정상 한국어 문장 (위험 패턴 0) → 0 hit', () => {
    const r = detectTranscriptPatterns('안녕하세요 오늘 날씨가 좋네요')
    expect(r.totalHits).toBe(0)
    expect(totalsConsistent(r)).toBe(true)
  })

  it('emptyResult() 동일 형상', () => {
    expect(emptyResult().totalHits).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// credential_like
// ─────────────────────────────────────────────────────────────────────────

describe('credential_like', () => {
  it('한국어 "비밀번호" + 영문대소+숫자 → hit', () => {
    const r = detectTranscriptPatterns('비밀번호는 ABC123 입니다')
    expect(r.hitsByCategory.credential_like).toBe(1)
  })

  it('"패스워드" + 영숫자 토큰 → hit', () => {
    const r = detectTranscriptPatterns('패스워드 입력 xY9z2k 했어요')
    expect(r.hitsByCategory.credential_like).toBe(1)
  })

  it('영문 "password" + 토큰 → hit', () => {
    const r = detectTranscriptPatterns('the password is Hello9 right')
    expect(r.hitsByCategory.credential_like).toBe(1)
  })

  it('비밀번호 키워드 부재 + 단순 영숫자 → no hit (false positive 방지)', () => {
    const r = detectTranscriptPatterns('내 자동차 모델은 ABC123 이야')
    expect(r.hitsByCategory.credential_like).toBe(0)
  })

  it('"비밀번호" 키워드 + 한글 숫자만 (영문 부재) → no hit', () => {
    const r = detectTranscriptPatterns('비밀번호 12345 이야')
    expect(r.hitsByCategory.credential_like).toBe(0)
  })

  it('"계정번호" + 영숫자 → hit', () => {
    const r = detectTranscriptPatterns('계정번호 user99X 알려줘')
    expect(r.hitsByCategory.credential_like).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// foreign_id_like
// ─────────────────────────────────────────────────────────────────────────

describe('foreign_id_like', () => {
  it('900101-1234567 형식 → hit', () => {
    const r = detectTranscriptPatterns('내 번호는 900101-1234567')
    expect(r.hitsByCategory.foreign_id_like).toBe(1)
  })

  it('900101-2345678 (외국인등록증 두번째 자리 2~8) → hit', () => {
    const r = detectTranscriptPatterns('외국인등록증 850515-5876543')
    expect(r.hitsByCategory.foreign_id_like).toBe(1)
  })

  it('900101 1234567 (공백) → hit', () => {
    const r = detectTranscriptPatterns('번호 900101 1234567')
    expect(r.hitsByCategory.foreign_id_like).toBe(1)
  })

  it('900101-9234567 (두번째 자리 9, 잘못된 형식) → no hit', () => {
    const r = detectTranscriptPatterns('이상한 900101-9234567')
    expect(r.hitsByCategory.foreign_id_like).toBe(0)
  })

  it('단순 13자리 숫자 (구분자 없음) → no hit (정확한 형식만)', () => {
    const r = detectTranscriptPatterns('번호 9001011234567')
    expect(r.hitsByCategory.foreign_id_like).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// payment_like
// ─────────────────────────────────────────────────────────────────────────

describe('payment_like', () => {
  it('"카드번호" + 16자리 → hit', () => {
    const r = detectTranscriptPatterns('카드번호는 1234567890123456 입니다')
    expect(r.hitsByCategory.payment_like).toBe(1)
  })

  it('"카드번호" + 4-4-4-4 구분자 → hit', () => {
    const r = detectTranscriptPatterns('카드번호 1234-5678-9012-3456')
    expect(r.hitsByCategory.payment_like).toBe(1)
  })

  it('"계좌번호" + 10+자리 → hit', () => {
    const r = detectTranscriptPatterns('계좌번호 1234567890')
    expect(r.hitsByCategory.payment_like).toBe(1)
  })

  it('"이체" + 10자리 숫자 → hit', () => {
    const r = detectTranscriptPatterns('이체 했어요 1234567890 으로')
    expect(r.hitsByCategory.payment_like).toBe(1)
  })

  it('결제 키워드 없이 16자리 숫자 → payment_like no hit', () => {
    const r = detectTranscriptPatterns('번호 1234567890123456')
    expect(r.hitsByCategory.payment_like).toBe(0)
  })

  it('"카드번호" + 5자리 숫자 (너무 짧음) → no hit', () => {
    const r = detectTranscriptPatterns('카드번호 12345')
    expect(r.hitsByCategory.payment_like).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// korean_name_like
// ─────────────────────────────────────────────────────────────────────────

describe('korean_name_like', () => {
  it('"김철수 사장" → hit', () => {
    const r = detectTranscriptPatterns('김철수 사장님이 오셨어요')
    expect(r.hitsByCategory.korean_name_like).toBeGreaterThanOrEqual(1)
  })

  it('"이영희 대리" → hit', () => {
    const r = detectTranscriptPatterns('이영희 대리에게 전달했어요')
    expect(r.hitsByCategory.korean_name_like).toBe(1)
  })

  it('"박지은씨" (호칭 씨) → hit', () => {
    const r = detectTranscriptPatterns('박지은씨한테 말했어요')
    expect(r.hitsByCategory.korean_name_like).toBe(1)
  })

  it('호칭 없는 단순 3자 한글 → no hit (false positive 방지)', () => {
    const r = detectTranscriptPatterns('김미영 같이 가자')
    expect(r.hitsByCategory.korean_name_like).toBe(0)
  })

  it('성씨 없는 호칭만 → no hit', () => {
    const r = detectTranscriptPatterns('우리 사장님이 말씀하셨다')
    expect(r.hitsByCategory.korean_name_like).toBe(0)
  })

  it('영어 이름 + 직책 → no hit', () => {
    const r = detectTranscriptPatterns('John 대리님이 출장 가셨어요')
    expect(r.hitsByCategory.korean_name_like).toBe(0)
  })

  it('한 줄에 2명 → 2 hits', () => {
    const r = detectTranscriptPatterns('김철수 사장님과 박영희 대리님이 회의를 했어요')
    expect(r.hitsByCategory.korean_name_like).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// numeric_sensitive_like
// ─────────────────────────────────────────────────────────────────────────

describe('numeric_sensitive_like', () => {
  it('6자리 숫자 시퀀스 → hit', () => {
    const r = detectTranscriptPatterns('번호 123456')
    expect(r.hitsByCategory.numeric_sensitive_like).toBe(1)
  })

  it('10자리 전화번호 → hit', () => {
    const r = detectTranscriptPatterns('연락처 0212345678')
    expect(r.hitsByCategory.numeric_sensitive_like).toBe(1)
  })

  it('5자리 숫자 → no hit (≥6 만)', () => {
    const r = detectTranscriptPatterns('숫자 12345')
    expect(r.hitsByCategory.numeric_sensitive_like).toBe(0)
  })

  it('소수점 포함 숫자 (3.141592) → no hit', () => {
    const r = detectTranscriptPatterns('파이는 3.141592')
    expect(r.hitsByCategory.numeric_sensitive_like).toBe(0)
  })

  it('한 줄에 여러 6+자리 → 각 카운트', () => {
    const r = detectTranscriptPatterns('123456 그리고 987654 두개')
    expect(r.hitsByCategory.numeric_sensitive_like).toBe(2)
  })

  // ── ID/hex 오탐 제외 (PR-ε) ──────────────────────────────────────────────
  // session_id hex(93c28f5700279c51)·utterance_id·audio_reference_id 의 숫자
  // 조각은 PII 가 아니므로 numeric_sensitive 로 잡지 않는다(영문/_/- 인접).
  it('session_id hex 안의 숫자 시퀀스 → no hit', () => {
    const r = detectTranscriptPatterns('93c28f5700279c51')
    expect(r.hitsByCategory.numeric_sensitive_like).toBe(0)
  })

  it('utterance_id (utt_<hex>_001) → no hit', () => {
    const r = detectTranscriptPatterns('utt_93c28f5700279c51_001')
    expect(r.hitsByCategory.numeric_sensitive_like).toBe(0)
  })

  it('JSON 라인의 id 필드 값 → no hit', () => {
    const r = detectTranscriptPatterns('"session_id": "93c28f5700279c51",')
    expect(r.hitsByCategory.numeric_sensitive_like).toBe(0)
  })

  it('영문 인접 숫자(abc1234567) → no hit (ID/토큰 조각)', () => {
    const r = detectTranscriptPatterns('ref abc1234567xyz')
    expect(r.hitsByCategory.numeric_sensitive_like).toBe(0)
  })

  it('하이픈 ISO 타임스탬프 조각 → no hit', () => {
    const r = detectTranscriptPatterns('2026-06-02T08:14:21')
    expect(r.hitsByCategory.numeric_sensitive_like).toBe(0)
  })

  // 진짜 PII 는 여전히 잡는다(회귀 가드)
  it('공백 사이 순수 6+자리(전화/식별번호) → 여전히 hit', () => {
    expect(detectTranscriptPatterns('번호 123456').hitsByCategory.numeric_sensitive_like).toBe(1)
    expect(detectTranscriptPatterns('연락처 0212345678').hitsByCategory.numeric_sensitive_like).toBe(1)
    expect(detectTranscriptPatterns('계좌 1234567890 입니다').hitsByCategory.numeric_sensitive_like).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// multiline / mixed language / per-hit metadata
// ─────────────────────────────────────────────────────────────────────────

describe('detectTranscriptPatterns — 복합 / multiline', () => {
  it('multiline + 여러 카테고리 동시', () => {
    const text = [
      '오늘 일정',
      '비밀번호: secret9X',
      '주민번호 900101-1234567',
      '김부장님 통화 요약',
      '계좌번호 1234567890',
      '안전한 문장',
    ].join('\n')
    const r = detectTranscriptPatterns(text)
    expect(r.hitsByCategory.credential_like).toBe(1)
    expect(r.hitsByCategory.foreign_id_like).toBe(1)
    expect(r.hitsByCategory.payment_like).toBe(1)
    expect(r.hitsByCategory.korean_name_like).toBe(1)
    // numeric_sensitive_like 도 같은 줄에서 hit 가능
    expect(r.totalHits).toBeGreaterThanOrEqual(4)
    expect(totalsConsistent(r)).toBe(true)
  })

  it('lineNumber metadata — 1-based 정확', () => {
    const text = '첫줄\n두번째 줄 password X9z1k2\n세번째'
    const r = detectTranscriptPatterns(text)
    const credHit = r.hits.find((h) => h.category === 'credential_like')
    expect(credHit?.lineNumber).toBe(2)
  })

  it('mixed language (영/한 혼합) 정상 → 0 hit', () => {
    const r = detectTranscriptPatterns('Hello 안녕하세요 today 오늘')
    expect(r.totalHits).toBe(0)
  })

  it('빈 줄 다수 → 0 hit', () => {
    const r = detectTranscriptPatterns('\n\n\n\n\n')
    expect(r.totalHits).toBe(0)
  })

  it('PatternHit 의 matchLength 가 양수', () => {
    const r = detectTranscriptPatterns('비밀번호 abc123')
    expect(r.hits[0].matchLength).toBeGreaterThan(0)
  })

  it('원문 노출 0 — PatternHit 에 raw text 키 부재', () => {
    const r = detectTranscriptPatterns('비밀번호 abc123 외국인등록증 900101-1234567')
    for (const h of r.hits) {
      const keys = Object.keys(h)
      expect(keys).toContain('category')
      expect(keys).toContain('matchLength')
      expect(keys).toContain('lineNumber')
      expect(keys).not.toContain('text')
      expect(keys).not.toContain('original')
      expect(keys).not.toContain('match')
      expect(keys).not.toContain('surface')
    }
  })

  it('totalsConsistent — sum(hitsByCategory)==totalHits==hits.length', () => {
    const text = '비밀번호 abc123 김부장님 1234567 카드번호 1234567890123456'
    const r = detectTranscriptPatterns(text)
    expect(totalsConsistent(r)).toBe(true)
  })

  it('하나의 줄에 여러 카테고리 → 줄 번호 모두 동일', () => {
    const text = '한 줄: 비밀번호 abc123 그리고 주민번호 900101-1234567'
    const r = detectTranscriptPatterns(text)
    for (const h of r.hits) {
      expect(h.lineNumber).toBe(1)
    }
  })

  it('대량 정상 텍스트 (위험 패턴 0) → totalHits=0 + 성능 sanity', () => {
    const text = Array.from({ length: 200 }, () => '안전한 한국어 문장입니다').join('\n')
    const r = detectTranscriptPatterns(text)
    expect(r.totalHits).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 9fa79d3c 회귀 fixture (진단 결과 카운트 정합)
// ─────────────────────────────────────────────────────────────────────────

describe('9fa79d3c 회귀 fixture (재현)', () => {
  it('진단 결과 패턴들 — 각 카테고리 1+ hit', () => {
    // 9fa79d3c 진단 보고서 패턴 (실 transcript 미포함, 동등 패턴 재구성).
    const text = [
      '오늘 시스템 로그인 정보를 알려드릴게요',
      '비밀번호는 Abc12345 입니다',
      '외국인등록증 800101-5234567',
      '전자결제 카드번호 1234-5678-9012-3456',
      '김부장님이 결재하셨어요',
      '연락처 0212345678',
    ].join('\n')
    const r = detectTranscriptPatterns(text)
    expect(r.hitsByCategory.credential_like).toBeGreaterThanOrEqual(1)
    expect(r.hitsByCategory.foreign_id_like).toBeGreaterThanOrEqual(1)
    expect(r.hitsByCategory.payment_like).toBeGreaterThanOrEqual(1)
    expect(r.hitsByCategory.korean_name_like).toBeGreaterThanOrEqual(1)
    expect(r.hitsByCategory.numeric_sensitive_like).toBeGreaterThanOrEqual(1)
    expect(r.totalHits).toBeGreaterThanOrEqual(5)
    expect(totalsConsistent(r)).toBe(true)
  })
})
