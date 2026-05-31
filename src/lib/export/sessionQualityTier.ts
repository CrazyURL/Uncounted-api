/**
 * PR-C — Session quality tier (export-time)
 *
 * 목적: export 산출물(`dataset_summary.json` / `dataset_quality_report.json` /
 * `call_*.json`)의 `session_quality_tier` 가 `null` 로 나오던 문제를 해결.
 * DB `sessions.session_quality_tier` 가 있으면 우선 사용, null 이면 발화별
 * `quality_grade` 분포로 export-time fallback 계산.
 *
 * 결정사항:
 *   - **DB write 0** — 본 함수는 순수 read-only. 산정 결과는 export 산출물에만 emit.
 *   - **schema/migration 변경 0** — `sessions.session_quality_tier` TEXT 컬럼 그대로.
 *   - **eligibility / safety / orphan filter / preflight 변경 0** — 산정 결과는
 *     `evaluateDatasetEligibility` 의 `QUALITY_REJECT_VALUES` 와 무관 (해당 룰은
 *     명시 reject 값만 체크). 본 helper 가 emit 하는 A_tier/B_tier/C_tier/D_tier/
 *     UNKNOWN 은 reject 값 집합에 없어 기존 eligibility 차단 0.
 *
 * 룰 (디렉티브 초안 그대로):
 *   - 분모 total = utterances 길이 (deliverable filter 후 또는 raw, 호출자 결정).
 *     `quality_grade` 가 null/유효외 값인 utterance 도 total 에 포함 (보수적 평가).
 *   - A_tier: A+B 비율 >= 0.90 and D/F=0
 *   - B_tier: A+B 비율 >= 0.70 and D/F 비율 <= 0.05
 *   - C_tier: A+B 비율 >= 0.50
 *   - D_tier: 그 외 (부분 null 포함)
 *   - UNKNOWN: total=0 또는 quality_grade 전부 null
 *
 * 기존 코드/문서의 다른 tier 룰 검색 결과:
 *   - `src/lib/export/datasetEligibility.ts:76-77` = `session_quality_tier` 의
 *     `reject`/`c_reject`(소문자 비교) 명시 값만 차단 (산정 룰 0).
 *   - 본 helper 의 emit 값과 충돌 0 (A_tier/B_tier/... 중 어느 것도 reject 패턴 아님).
 */

export type SessionQualityTier =
  | 'A_tier'
  | 'B_tier'
  | 'C_tier'
  | 'D_tier'
  | 'UNKNOWN'

export type TierSource = 'db' | 'computed' | 'unknown'

export interface QualityGradeDistribution {
  A: number
  B: number
  C: number
  D: number
  F: number
  null: number
}

export interface SessionQualityTierMetrics {
  total: number
  distribution: QualityGradeDistribution
  ab_ratio: number
  df_ratio: number
}

export interface SessionQualityTierResult {
  tier: SessionQualityTier | string
  source: TierSource
  tier_reason: string
  metrics: SessionQualityTierMetrics
}

export interface SessionQualityTierInput {
  /** DB sessions.session_quality_tier (있으면 우선). */
  db_value?: string | null
  /** Deliverable filter 후 또는 raw utterances. quality_grade 필드만 사용.
   *  Record 형태 (structural typing) — 호출자 UtteranceRow 등 임의 row shape 호환. */
  utterances?: ReadonlyArray<Record<string, unknown>> | null
}

const COMPUTED_TIERS: ReadonlyArray<SessionQualityTier> = [
  'A_tier',
  'B_tier',
  'C_tier',
  'D_tier',
  'UNKNOWN',
]

function normalizeGrade(value: unknown): 'A' | 'B' | 'C' | 'D' | 'F' | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toUpperCase()
  if (trimmed === 'A' || trimmed === 'B' || trimmed === 'C' || trimmed === 'D' || trimmed === 'F') {
    return trimmed
  }
  return null
}

function buildEmptyDistribution(): QualityGradeDistribution {
  return { A: 0, B: 0, C: 0, D: 0, F: 0, null: 0 }
}

export function computeGradeDistribution(
  utterances: ReadonlyArray<Record<string, unknown>> | null | undefined,
): QualityGradeDistribution {
  const dist = buildEmptyDistribution()
  if (!utterances) return dist
  for (const u of utterances) {
    const g = normalizeGrade(u?.quality_grade)
    if (g === null) {
      dist.null += 1
    } else {
      dist[g] += 1
    }
  }
  return dist
}

function distributionTotal(d: QualityGradeDistribution): number {
  return d.A + d.B + d.C + d.D + d.F + d.null
}

function buildMetrics(distribution: QualityGradeDistribution): SessionQualityTierMetrics {
  const total = distributionTotal(distribution)
  const ab = distribution.A + distribution.B
  const df = distribution.D + distribution.F
  const ab_ratio = total === 0 ? 0 : ab / total
  const df_ratio = total === 0 ? 0 : df / total
  return { total, distribution, ab_ratio, df_ratio }
}

/**
 * tier 산정. DB 우선 → utterances 분포 fallback → UNKNOWN.
 *
 * `db_value` 가 비어있지 않은 문자열이면 그대로 emit (소스 = 'db'). 본 함수는 DB 값을
 * normalize 하지 않음 — DB 가 임의 문자열(reject/c_reject/A_tier/legacy 값 등) 일 수
 * 있으며, eligibility 단계가 별도 reject 룰 적용. emit 의미: "DB 가 신뢰의 출처".
 */
export function computeSessionQualityTier(
  input: SessionQualityTierInput,
): SessionQualityTierResult {
  // 1. DB 값 우선 (있으면 그대로)
  const dbValue = typeof input.db_value === 'string' ? input.db_value.trim() : ''
  const distribution = computeGradeDistribution(input.utterances)
  const metrics = buildMetrics(distribution)
  if (dbValue.length > 0) {
    return {
      tier: dbValue,
      source: 'db',
      tier_reason: 'db_value',
      metrics,
    }
  }

  // 2. utterances 기반 fallback
  if (metrics.total === 0) {
    return {
      tier: 'UNKNOWN',
      source: 'unknown',
      tier_reason: 'no_utterances',
      metrics,
    }
  }
  if (distribution.null === metrics.total) {
    return {
      tier: 'UNKNOWN',
      source: 'unknown',
      tier_reason: 'all_null_grades',
      metrics,
    }
  }

  if (metrics.ab_ratio >= 0.9 && distribution.D + distribution.F === 0) {
    return {
      tier: 'A_tier',
      source: 'computed',
      tier_reason: 'ab_ratio>=0.9_and_df=0',
      metrics,
    }
  }
  if (metrics.ab_ratio >= 0.7 && metrics.df_ratio <= 0.05) {
    return {
      tier: 'B_tier',
      source: 'computed',
      tier_reason: 'ab_ratio>=0.7_and_df_ratio<=0.05',
      metrics,
    }
  }
  if (metrics.ab_ratio >= 0.5) {
    return {
      tier: 'C_tier',
      source: 'computed',
      tier_reason: 'ab_ratio>=0.5',
      metrics,
    }
  }
  return {
    tier: 'D_tier',
    source: 'computed',
    tier_reason: 'fallback',
    metrics,
  }
}

/**
 * 분류 helper — UI/문서용. tier 값이 computed-helper 가 emit 하는 표준 5종 중
 * 하나인지 확인.
 */
export function isComputedTier(value: unknown): value is SessionQualityTier {
  return typeof value === 'string' && (COMPUTED_TIERS as readonly string[]).includes(value)
}
