// PII 이름 후보 정밀도 필터 (PII-1A 보강).
//
// 배경: voice-api detect_pii_spans 의 한글 이름 탐지는 "성씨+1~2자" 패턴이라 오탐이 매우 높다
//   (dev 실측 ~7,576 후보 전부 needs_human_decision). 그대로 적재하면 관리자 큐가 노이즈 큐가 된다.
//
// 정책: predicted_type='이름' 후보는 **호칭/직함이 바로 뒤따를 때만** 채택한다(고정밀 discovery 채널).
//   - OOO님 / OOO 씨 / OOO 과장님 / OOO 매니저님 ...
//   - 호칭 없는 2~3자 이름 단독 후보는 드롭(오탐 대부분).
//   - 구조적 PII(전화/주민/카드/이메일/IP 등 비-이름 타입)는 필터 없이 그대로 통과.
//
// recall 은 후보 증가가 아니라 "discovery 1회 → 관리자 confirm → denylist 자동보강 → Track 0
//   exact-match 전 occurrence 마스킹" 으로 회수한다(설계: design_pii_name_pipeline_20260524.md).
//
// ⚠️ 이 모듈이 정밀도 필터의 **정본(single source of truth)** 이다. backfill_pii_candidates.mjs
//   는 .mjs(빌드 비경유)라 동일 로직을 인라인 복제한다 — 토큰 목록 변경 시 양쪽 동기화할 것.

/** detect_pii_spans 가 이름 후보에 부여하는 predicted_type 값. */
export const NAME_PII_TYPE = '이름'

/**
 * 이름 뒤에 붙으면 "사람 이름"일 가능성이 높은 호칭/직함 토큰.
 * 길이 내림차순 정렬 불필요(startsWith 검사) — 단 부분 토큰('과장')이 확장형('과장님')을 포함하도록 짧은 형을 둔다.
 */
export const HONORIFIC_TITLES: readonly string[] = [
  '님', '씨',
  '매니저', '과장', '차장', '부장', '팀장', '대표', '사장', '이사', '상무', '전무', '회장',
  '선생', '교수', '박사', '원장', '실장', '대리', '주임', '사원', '국장', '처장', '위원',
  '총장', '학장', '소장', '반장', '조장', '센터장', '본부장', '지점장', '연구원', '책임',
  '수석', '전임', '감독', '코치', '기사', '고객',
]

/** 호칭이 뒤따라도 사람 이름으로 보기 어려운 흔한 3자 표현(보수적·확장 가능). */
export const NAME_STOPWORDS: ReadonlySet<string> = new Set<string>([
  '안녕하', '감사합', '죄송합', '말씀드', '그러니', '그래서', '그러면', '하니까',
])

/** detect-batch 후보 1건(원문 미포함 — type/offset/confidence/tier 만). */
export interface DetectedCandidateLike {
  type: string
  char_start: number
  char_end: number
}

const MAX_HONORIFIC_LOOKAHEAD = 6

/** 텍스트의 start 위치에서 (공백 스킵 후) HONORIFIC_TITLES 중 하나로 시작하면 그 토큰을 반환. */
function honorificAt(text: string, start: number): string | null {
  let i = start
  while (i < text.length && /\s/.test(text[i] as string)) i++
  const window = text.slice(i, i + MAX_HONORIFIC_LOOKAHEAD)
  for (const token of HONORIFIC_TITLES) {
    if (window.startsWith(token)) return token
  }
  return null
}

/**
 * 이름 후보가 호칭/직함 인접(고정밀)인지 판정.
 *
 * - 후보 span 바로 뒤(공백 허용)에 호칭이 오거나,
 * - span 자체가 호칭으로 끝나는 경우(탐지기가 호칭까지 span 에 포함한 경우) true.
 * - span 텍스트가 NAME_STOPWORDS 에 정확히 해당하면 false(흔한 비-이름 표현).
 */
export function isHonorificAdjacentName(text: string, charStart: number, charEnd: number): boolean {
  if (!text || charStart == null || charEnd == null || charEnd <= charStart) return false
  if (charStart < 0 || charEnd > text.length) return false

  const span = text.slice(charStart, charEnd)
  if (NAME_STOPWORDS.has(span)) return false

  // 1) span 바로 뒤 호칭.
  if (honorificAt(text, charEnd) != null) return true

  // 2) span 자체가 호칭으로 끝남(탐지기가 호칭 포함 span 반환한 경우).
  for (const token of HONORIFIC_TITLES) {
    if (span.length > token.length && span.endsWith(token)) return true
  }
  return false
}

/**
 * 후보 목록에서 이름 후보는 호칭 인접일 때만 남기고, 비-이름(구조 PII) 후보는 그대로 통과.
 * @param candidates detect-batch 후보(원문 미포함)
 * @param text 해당 발화 transcript_text(호칭 인접 검사용 — 저장/출력하지 않음)
 */
export function filterCandidatesByPrecision<T extends DetectedCandidateLike>(
  candidates: readonly T[],
  text: string,
): T[] {
  return candidates.filter((c) => {
    if (c.type !== NAME_PII_TYPE) return true // 구조 PII 통과
    return isHonorificAdjacentName(text, c.char_start, c.char_end)
  })
}
