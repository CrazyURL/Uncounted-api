/**
 * Numeric pattern extractor — PII-masked numeric tokens.
 *
 * 안전선 #3, #4: surface_text / normalized 원문은 절대 저장 X.
 *   - 추출기는 마스킹된 토큰만 반환 (`surface_masked`, `normalized_masked`).
 *   - 원문 보존이 필요한 디버깅은 별도 내부 로그(외부 ZIP 미노출)에서 처리.
 *
 * 출력 스키마 (4 필드, SPEC §4.2.17 외부 노출 가능 서브셋):
 *   { type, surface_masked, normalized_masked, pii_related }
 */

export type NumericPatternType =
  | 'phone_number'
  | 'date'
  | 'time'
  | 'amount'
  | 'account_number'
  | 'age'
  | 'birth_date'
  | 'zipcode'
  | 'statistics'

export interface NumericPattern {
  type: NumericPatternType
  /** 마스킹된 표면형 — `[TYPE]` 형태의 대문자 토큰 (원문 X). */
  surface_masked: string
  /** 마스킹된 정규형 — `[TYPE]` 형태의 대문자 토큰 (원문 X). */
  normalized_masked: string
  /** PII 위험 여부 — phone/account/birth/age/zipcode → true, date/time/amount/statistics → false. */
  pii_related: boolean
}

interface PatternRule {
  type: NumericPatternType
  regex: RegExp
  pii_related: boolean
  surface_masked: string
  normalized_masked: string
}

/**
 * 패턴 규칙 — 우선순위 순. 동일 영역 겹침 시 앞 규칙 우선.
 *
 * 정렬 근거 (앞이 더 좁고 구체적):
 *   1. phone_number (Korean 010-/02- 등) — 구체적 prefix
 *   2. account_number (3-6/2-6/2-7 digits 또는 10~14자리 연속) — 범용
 *   3. birth_date (YYYYMMDD / YYYY년 M월 D일) — date 보다 먼저
 *   4. date (YYYY-MM-DD, M월 D일)
 *   5. time (HH:MM, X시 X분, 오후 X시)
 *   6. amount (X원, X만원)
 *   7. zipcode (5자리 + 주소 단어)
 *   8. age (X세, X대)
 *   9. statistics (X%, X점)
 */
const PATTERN_RULES: PatternRule[] = [
  {
    type: 'phone_number',
    regex:
      /\b(?:0(?:2|[3-6][1-5]|7[0-9]|8[0-9])[-\s]?\d{3,4}[-\s]?\d{4}|01[016-9][-\s]?\d{3,4}[-\s]?\d{4})\b/g,
    pii_related: true,
    surface_masked: '[PHONE]',
    normalized_masked: '[PHONE]',
  },
  {
    type: 'account_number',
    regex: /\b\d{3,6}-\d{2,6}-\d{2,7}\b|\b\d{10,14}\b/g,
    pii_related: true,
    surface_masked: '[ACCOUNT]',
    normalized_masked: '[ACCOUNT]',
  },
  {
    // birth_date (compact YYYYMMDD)
    type: 'birth_date',
    regex: /\b(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b/g,
    pii_related: true,
    surface_masked: '[BIRTHDATE]',
    normalized_masked: '[BIRTHDATE]',
  },
  {
    // birth_date (Korean: YYYY년 M월 D일)
    type: 'birth_date',
    regex: /\b(?:19|20)\d{2}년\s?(?:0?[1-9]|1[0-2])월\s?(?:0?[1-9]|[12]\d|3[01])일/g,
    pii_related: true,
    surface_masked: '[BIRTHDATE]',
    normalized_masked: '[BIRTHDATE]',
  },
  {
    // date (Western YYYY-MM-DD / Korean M월 D일 without 년)
    type: 'date',
    regex:
      /\b(?:(?:19|20)\d{2}[-./](?:0?[1-9]|1[0-2])[-./](?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|1[0-2])월\s?(?:0?[1-9]|[12]\d|3[01])일)\b/g,
    pii_related: false,
    surface_masked: '[DATE]',
    normalized_masked: '[DATE]',
  },
  {
    type: 'time',
    regex:
      /(?:\b(?:[01]?\d|2[0-3]):[0-5]\d\b|(?:오전|오후)\s?\d{1,2}시(?:\s?\d{1,2}분)?|\b\d{1,2}시\s?\d{1,2}분)/g,
    pii_related: false,
    surface_masked: '[TIME]',
    normalized_masked: '[TIME]',
  },
  {
    type: 'amount',
    regex: /\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?(?:원|만\s?원|억\s?원|만|억|달러|불|USD|KRW)/g,
    pii_related: false,
    surface_masked: '[AMOUNT]',
    normalized_masked: '[AMOUNT]',
  },
  {
    type: 'zipcode',
    regex: /\b\d{5}\b(?=\s?(?:번지|호|동|로|길|아파트|우편번호))/g,
    pii_related: true,
    surface_masked: '[ZIPCODE]',
    normalized_masked: '[ZIPCODE]',
  },
  {
    type: 'age',
    regex: /\b\d{1,2}\s?(?:세|살|대)\b/g,
    pii_related: true,
    surface_masked: '[AGE]',
    normalized_masked: '[AGE]',
  },
  {
    type: 'statistics',
    regex: /\b\d{1,3}(?:\.\d+)?\s?(?:%|퍼센트|점)/g,
    pii_related: false,
    surface_masked: '[PERCENT]',
    normalized_masked: '[PERCENT]',
  },
]

interface RawMatch {
  rule_priority: number
  start: number
  end: number
  type: NumericPatternType
  surface_masked: string
  normalized_masked: string
  pii_related: boolean
}

/**
 * 추출. 입력이 문자열이 아니면 빈 배열.
 *
 * 안전선 #3, #4: surface_text / normalized 원문은 반환 객체에 절대 포함 X.
 */
export function extractNumericPatterns(text: unknown): NumericPattern[] {
  if (typeof text !== 'string' || text.length === 0) return []

  const collected: RawMatch[] = []
  PATTERN_RULES.forEach((rule, priority) => {
    rule.regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.regex.exec(text)) !== null) {
      collected.push({
        rule_priority: priority,
        start: m.index,
        end: m.index + m[0].length,
        type: rule.type,
        surface_masked: rule.surface_masked,
        normalized_masked: rule.normalized_masked,
        pii_related: rule.pii_related,
      })
    }
  })

  if (collected.length === 0) return []

  const sorted = collected.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    if (a.rule_priority !== b.rule_priority) return a.rule_priority - b.rule_priority
    return b.end - b.start - (a.end - a.start)
  })

  const output: NumericPattern[] = []
  let lastEnd = -1
  for (const m of sorted) {
    if (m.start >= lastEnd) {
      output.push({
        type: m.type,
        surface_masked: m.surface_masked,
        normalized_masked: m.normalized_masked,
        pii_related: m.pii_related,
      })
      lastEnd = m.end
    }
  }
  return output
}
