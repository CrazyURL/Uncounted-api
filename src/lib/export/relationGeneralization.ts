/**
 * 화자 관계(speaker_relation) K-익명성 게이트 + 일반화 tier.
 *
 * 글로벌 프라이버시 표준(NIST SP 800-122 / GDPR Art.4 linkability / k-anonymity)을
 * 화자 관계 노출에 적용한다. 관계값은 quasi-identifier 이므로 "원문 그대로" 노출 시
 * 희귀값(예: 1:1 수직지정·희귀 직군)이 재식별(linkage) 벡터가 된다.
 *
 * 게이트 규칙 (K=5):
 *   1. 데이터셋 전체(session_speakers 전 행)에서 관계값별 빈도를 집계한다.
 *   2. count(relation) >= 5  → 원문 관계 노출.
 *   3. count(relation) <  5  → 일반화 tier 로 치환. tier 합산 count 도 <5 면 → null.
 *   4. relation 없음/미지/룩업미스 → null.
 *
 * ★데이터셋 레벨 집계: 단건 export 여도 전체 빈도표(frequency map)를 기준으로 판정한다.
 *   (단건만 보면 모든 값이 count=1 이 되어 항상 일반화돼 버린다.)
 *
 * 본 모듈은 순수 함수만 — DB I/O 없음(빈도표는 호출측이 주입). DB write 0.
 */

/** K-익명성 임계값. count >= K 인 관계값만 원문 노출. */
export const K_ANONYMITY_THRESHOLD = 5

/**
 * 일반화 tier 사전 — 희귀 원문값을 상위 범주로 치환.
 * (디렉터 승인 map, 2026-06-05)
 */
export const RELATION_GENERALIZATION_MAP: Readonly<Record<string, string>> = {
  // 교육관계자
  교사: '교육관계자',
  교수: '교육관계자',
  강사: '교육관계자',
  // 가족
  부모: '가족',
  자녀: '가족',
  형제자매: '가족',
  배우자: '가족',
  // 직장관계
  직장동료: '직장관계',
  직장상사: '직장관계',
  // 거래관계
  거래처: '거래관계',
  고객: '거래관계',
  // 지인
  친구: '지인',
}

/**
 * 관계값 → 일반화 tier. map 에 없는 미지값은 null(노출 금지).
 */
export function generalizeRelation(relation: string): string | null {
  return RELATION_GENERALIZATION_MAP[relation] ?? null
}

/** call.json speakers[].relation_candidate 객체 (또는 미노출 시 null). */
export interface RelationCandidate {
  /** 노출 관계값(원문 또는 일반화 tier). */
  value: string
  /** true = 일반화 tier 로 치환됨, false = 원문 그대로. */
  generalized: boolean
  /** 추정 방식(확정 아님 명시). */
  method: 'heuristic_mvp'
  /** 추정값 disclaimer(확정 단정 금지). */
  disclaimer: string
}

const RELATION_DISCLAIMER =
  'Inferred relationship, probabilistic. Not verified.'

/**
 * 관계 빈도표(데이터셋 전체) → speaker_label 단건 관계값의 노출 결정.
 *
 * @param relation        해당 화자의 speaker_relation 원문 (null/빈문자 → 미노출).
 * @param relationCounts  관계값별 데이터셋 전체 빈도 (원문 기준 집계).
 * @returns RelationCandidate 또는 null(K 게이트 미통과 / 관계 부재 / 미지값).
 */
export function resolveRelationCandidate(
  relation: string | null | undefined,
  relationCounts: ReadonlyMap<string, number>,
): RelationCandidate | null {
  const value =
    typeof relation === 'string' && relation.trim().length > 0 ? relation.trim() : null
  if (value === null) return null

  // 규칙 2: 원문 count >= K → 원문 노출.
  const rawCount = relationCounts.get(value) ?? 0
  if (rawCount >= K_ANONYMITY_THRESHOLD) {
    return {
      value,
      generalized: false,
      method: 'heuristic_mvp',
      disclaimer: RELATION_DISCLAIMER,
    }
  }

  // 규칙 3: count < K → 일반화 tier 로 치환.
  const tier = generalizeRelation(value)
  if (tier === null) return null // map 미지값 → 미노출(규칙 4).

  // tier 합산 count = tier 로 매핑되는 모든 원문값 count 합.
  const tierCount = sumTierCount(tier, relationCounts)
  if (tierCount < K_ANONYMITY_THRESHOLD) return null // tier 도 희귀 → null.

  return {
    value: tier,
    generalized: true,
    method: 'heuristic_mvp',
    disclaimer: RELATION_DISCLAIMER,
  }
}

/**
 * tier 합산 count — 해당 tier 로 일반화되는 모든 원문값의 데이터셋 빈도 합.
 */
function sumTierCount(tier: string, relationCounts: ReadonlyMap<string, number>): number {
  let sum = 0
  for (const [raw, mapped] of Object.entries(RELATION_GENERALIZATION_MAP)) {
    if (mapped === tier) sum += relationCounts.get(raw) ?? 0
  }
  return sum
}

/**
 * session_speakers 행 배열 → 관계값별 빈도 Map (원문 기준).
 * relation 이 null/빈문자인 행은 집계에서 제외.
 *
 * ⚠️ 입력은 *데이터셋 전체* 행이어야 한다. 단건 세션 행만 주면 K 게이트가 무의미.
 */
export function buildRelationFrequency(
  rows: ReadonlyArray<{ speaker_relation?: string | null }>,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const v =
      typeof row.speaker_relation === 'string' && row.speaker_relation.trim().length > 0
        ? row.speaker_relation.trim()
        : null
    if (v === null) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return counts
}
