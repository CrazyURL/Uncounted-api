// ── Export safety preflight — transcript pattern detector ────────────────
//
// 설계: scripts/analysis/session_9fa79d3c_export_qa_diagnosis (PR-A P0)
// 동기: 세션 9fa79d3c export QA 에서 worker.py 의 detect_pii_spans 가 한국어 위험
// 패턴을 못 잡아 ZIP 의 pii_labels=0 으로 표기되는 silent failure 확인.
//
// 본 모듈은 **export-side defense-in-depth**:
//   - voice-api 측 detector 가 놓친 위험 패턴을 ZIP 빌드 직전에 1회 sweep
//   - 위반 ≥1건 → fail-closed (호출자가 throw)
//   - voice-api PR (PR-B) 와 직교, 둘 중 하나만 동작해도 안전
//
// 보안 원칙:
//   - 원문(transcript / matched substring)은 절대 반환·로그하지 않는다.
//   - 반환값 = category × count + (옵션) sequence_order 만.
//   - sample text / surface / normalized text 등 노출 0.
//
// 호출자: src/services/export/safety-checks.ts 의 validateExportSafety()

/**
 * 탐지 카테고리 — 디렉터 명시 5개.
 * 각 카테고리 안전한 식별자만 외부에 노출 (원문 0).
 */
export type TranscriptPatternCategory =
  | 'credential_like'      // 비밀번호/패스워드/로그인/계정 컨텍스트 + 영문대소+숫자 혼합
  | 'foreign_id_like'      // 외국인등록증 / 주민등록번호 패턴
  | 'payment_like'         // 전자결제 / 카드번호 / 계좌번호 / 이체 컨텍스트 + 숫자
  | 'korean_name_like'     // 한국 성씨 + 2자 이름 후보
  | 'numeric_sensitive_like' // 길이 ≥6 의 Arabic 숫자 시퀀스 (의미 있는 식별번호)

/** 한 매치의 metadata (원문 미포함). 호출자가 로그할 수 있는 안전한 식별자만. */
export interface PatternHit {
  readonly category: TranscriptPatternCategory
  /** 매치된 문자열의 길이 (원문 없이 sanity check 용). */
  readonly matchLength: number
  /** 매치된 줄 번호 (1-based, line-based 입력일 때). 알 수 없으면 -1. */
  readonly lineNumber: number
}

export interface DetectorResult {
  readonly totalHits: number
  readonly hitsByCategory: Readonly<Record<TranscriptPatternCategory, number>>
  readonly hits: ReadonlyArray<PatternHit>
}

/** Feature flag — env `EXPORT_SAFETY_PREFLIGHT_ENABLED='false'` 명시 시에만 우회. */
export function isSafetyPreflightEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXPORT_SAFETY_PREFLIGHT_ENABLED !== 'false'
}

// ── 패턴 정의 ─────────────────────────────────────────────────────────────

/**
 * credential_like — 비밀번호 컨텍스트.
 *
 * 두 step:
 *   1. 비밀번호 키워드 (한/영) 가 줄 안에 등장
 *   2. 같은 줄 안에 영문대소+숫자 혼합 4자 이상 토큰 또는 4자 이상 영숫자 조합
 *
 * Korean speech 에서 "비밀번호 ABC123" 같은 표현을 잡는 것이 목적.
 */
const CREDENTIAL_KEYWORDS = [
  '비밀번호', '패스워드', '암호', '로그인 정보', '계정 정보', '계정번호',
  'password', 'passwd', 'login', 'credentials',
] as const

const CREDENTIAL_TOKEN_RE = /(?=[A-Za-z])(?=.*\d)[A-Za-z0-9]{4,}/

/**
 * foreign_id_like — 외국인등록증 / 주민등록번호 동형.
 *   - 형식: 6자리 + 구분자(`-`/`_`/공백) + 1~8 시작 7자리.
 *   - 구분자 필수 (단순 13자리 연속 숫자는 false positive 가능성 높아 제외).
 */
const FOREIGN_ID_RE = /\b\d{6}[-_\s][1-8]\d{6}\b/

/** payment_like — 결제 컨텍스트 + 숫자. */
const PAYMENT_KEYWORDS = [
  '카드번호', '신용카드', '계좌번호', '계좌이체', '전자결제',
  '이체', '입금', '송금', 'CVC', 'CVV',
] as const

const PAYMENT_DIGIT_RE = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b|\b\d{10,16}\b/

/**
 * korean_name_like — 성씨 + 2자 이름 후보.
 *
 * 디렉터 명시: 임계치 보수적 (false positive 최소). 호칭 동반 시만 hit.
 *   "<성씨><이름2자> <호칭|씨|님>" 패턴.
 *
 * 호칭 부재 단순 3자 한글은 너무 광범위(false positive 다수) → 호칭 동반만.
 */
const KOREAN_SURNAMES = [
  '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임',
  '한', '오', '서', '신', '권', '황', '안', '송', '류', '전',
  '홍', '고', '문', '양', '손', '배', '백', '허', '유', '남',
  '심', '노', '하', '곽', '성', '차', '주', '우', '구', '민',
] as const

const KOREAN_TITLES = [
  '씨', '님', '사장', '대표', '대리', '과장', '차장', '부장',
  '팀장', '실장', '이사', '상무', '전무', '부사장', '회장',
  '교수', '박사', '선생', '의원', '의사', '간호사', '변호사',
  '소장', '관장', '회계사',
] as const

// "<성씨><한글2자> <호칭>" — 호칭 앞 공백 허용.
//   - 이름 부분 정확히 2자 ([가-힣]{2}) — 1자 이름은 false positive 다수("우리 사장" 의 "리").
//   - 디렉터 명시: false positive 보수적 제외.
const KOREAN_NAME_TITLE_RE = new RegExp(
  `(?:${KOREAN_SURNAMES.join('|')})[가-힣]{2}\\s*(?:${KOREAN_TITLES.join('|')})`,
  'g',
)

/** numeric_sensitive_like — 6+ 자리 Arabic 숫자 (전화번호 / 식별번호). */
const NUMERIC_SENSITIVE_RE = /(?<![\d.])\d{6,}(?![\d.])/g

// ── 핵심 detector ────────────────────────────────────────────────────────

const EMPTY_RESULT: DetectorResult = {
  totalHits: 0,
  hitsByCategory: Object.freeze({
    credential_like: 0,
    foreign_id_like: 0,
    payment_like: 0,
    korean_name_like: 0,
    numeric_sensitive_like: 0,
  }) as Readonly<Record<TranscriptPatternCategory, number>>,
  hits: Object.freeze([]),
}

/**
 * 본 함수는 **순수**. 호출자가 원문 노출 책임을 안 짐.
 *
 * @param text 검사 대상 텍스트 (단일 string, 멀티라인 OK).
 * @returns category × count + per-hit metadata (원문 0).
 */
export function detectTranscriptPatterns(text: string): DetectorResult {
  if (typeof text !== 'string' || text.length === 0) {
    return EMPTY_RESULT
  }

  const lines = text.split(/\r?\n/)
  const hits: PatternHit[] = []
  const byCategory: Record<TranscriptPatternCategory, number> = {
    credential_like: 0,
    foreign_id_like: 0,
    payment_like: 0,
    korean_name_like: 0,
    numeric_sensitive_like: 0,
  }

  function record(category: TranscriptPatternCategory, matchLength: number, lineNumber: number) {
    hits.push({ category, matchLength, lineNumber })
    byCategory[category] += 1
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNumber = i + 1

    // credential_like — 키워드 + 영숫자 토큰
    const hasCredKeyword = CREDENTIAL_KEYWORDS.some((kw) =>
      line.toLowerCase().includes(kw.toLowerCase()),
    )
    if (hasCredKeyword) {
      const m = line.match(CREDENTIAL_TOKEN_RE)
      if (m && m[0]) record('credential_like', m[0].length, lineNumber)
    }

    // foreign_id_like — 정규식 단독
    const fid = line.match(FOREIGN_ID_RE)
    if (fid && fid[0]) record('foreign_id_like', fid[0].length, lineNumber)

    // payment_like — 키워드 + 숫자 시퀀스
    const hasPayKeyword = PAYMENT_KEYWORDS.some((kw) => line.includes(kw))
    if (hasPayKeyword) {
      const m = line.match(PAYMENT_DIGIT_RE)
      if (m && m[0]) record('payment_like', m[0].length, lineNumber)
    }

    // korean_name_like — 성씨+이름+호칭
    const nameMatches = line.matchAll(KOREAN_NAME_TITLE_RE)
    for (const m of nameMatches) {
      if (m[0]) record('korean_name_like', m[0].length, lineNumber)
    }

    // numeric_sensitive_like — 6+ 자리 숫자
    const numMatches = line.matchAll(NUMERIC_SENSITIVE_RE)
    for (const m of numMatches) {
      if (m[0]) record('numeric_sensitive_like', m[0].length, lineNumber)
    }
  }

  return {
    totalHits: hits.length,
    hitsByCategory: Object.freeze(byCategory),
    hits: Object.freeze(hits),
  }
}

/** 결과 정합용 sanity helper — totalHits == sum(hitsByCategory). */
export function totalsConsistent(r: DetectorResult): boolean {
  const sum = (Object.values(r.hitsByCategory) as number[]).reduce((a, b) => a + b, 0)
  return r.totalHits === sum && r.totalHits === r.hits.length
}

/**
 * 빈 결과 정규화 (외부 노출용 — 안전 default).
 */
export function emptyResult(): DetectorResult {
  return EMPTY_RESULT
}
