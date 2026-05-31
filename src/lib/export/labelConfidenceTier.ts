/**
 * PR-D — Label Confidence Tier (export-time)
 *
 * 목적: export 산출물 (`labels/*.jsonl`) 의 `confidence_tier` 가 현재 `null` 로 하드코딩
 * (`export-builder.ts:454`). PR-C `session_quality_tier` 와 동일 패턴으로 utterance-level
 * confidence tier 산정.
 *
 * 결정사항:
 *   - **DB write 0** — 본 함수는 순수 read-only. 결과는 export 산출물에만 emit.
 *   - **schema/migration 변경 0** — `label-schema.ts:74-79` 의 `confidence_tier` enum
 *     (`high`/`medium`/`needs_review`/null) 그대로 emit.
 *   - **safety preflight 변경 0** — emit 값 (`high`/`medium`/`needs_review`) 이 PR #58
 *     transcript-pattern-detector 5 카테고리 정규식 어디에도 surface 매칭 안 됨.
 *
 * 룰:
 *   - `high`         confidence >= 0.7
 *   - `medium`       0.4 <= confidence < 0.7
 *   - `needs_review` confidence < 0.4 또는 null
 *
 * source 우선순위:
 *   1. `label_confidence` (사람 검수 후 라벨 신뢰도)
 *   2. `emotion_confidence` (auto label fallback, voice-api `auto_label_service`)
 *   3. 둘 다 null → `needs_review` (source=none)
 *
 * 실측 분포 (Phase C 2026-05-31, founder Tier-0 15 sessions / 546 utterances):
 *   high=26.7% / medium=55.7% / needs_review(<0.4)=3.7% / null fallback=13.9%
 *   → 합산 needs_review=17.6%. emotion_confidence mean=0.627 / median=0.621 / p75=0.723
 *   (voice-api emotion-only v20260524_095713 macro_f1=0.5254 와 정합).
 */

export type ConfidenceTier = 'high' | 'medium' | 'needs_review'
export type ConfidenceTierSource = 'label' | 'emotion' | 'none'

export interface LabelConfidenceTierResult {
  tier: ConfidenceTier
  source: ConfidenceTierSource
  value: number | null
}

export interface LabelConfidenceTierInput {
  /** 사람 검수 후 라벨 신뢰도 (우선). number 또는 number-like string. */
  label_confidence?: number | string | null
  /** voice-api emotion-only 모델 신뢰도 (fallback). */
  emotion_confidence?: number | string | null
}

const TIER_HIGH_MIN = 0.7
const TIER_MEDIUM_MIN = 0.4

function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null
  }
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (trimmed.length === 0) return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function classify(value: number): ConfidenceTier {
  if (value >= TIER_HIGH_MIN) return 'high'
  if (value >= TIER_MEDIUM_MIN) return 'medium'
  return 'needs_review'
}

/**
 * tier 산정. label > emotion > none.
 *
 * - label_confidence 유효 (number-like, finite) → tier 산정 (source=label)
 * - 없으면 emotion_confidence fallback (source=emotion)
 * - 둘 다 invalid/null → needs_review (source=none, value=null)
 *
 * 음수/>1 값도 classify 동일 적용 (defensive 정규화 없음 — 호출자 정책).
 */
export function computeLabelConfidenceTier(
  input: LabelConfidenceTierInput,
): LabelConfidenceTierResult {
  const labelVal = toFiniteNumber(input.label_confidence)
  if (labelVal !== null) {
    return { tier: classify(labelVal), source: 'label', value: labelVal }
  }
  const emoVal = toFiniteNumber(input.emotion_confidence)
  if (emoVal !== null) {
    return { tier: classify(emoVal), source: 'emotion', value: emoVal }
  }
  return { tier: 'needs_review', source: 'none', value: null }
}

const TIERS: ReadonlyArray<ConfidenceTier> = ['high', 'medium', 'needs_review']

export function isConfidenceTier(value: unknown): value is ConfidenceTier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value)
}
