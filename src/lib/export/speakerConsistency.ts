/**
 * Speaker consistency / normalized confidence (D3) — **buyer-facing 신뢰도 메타데이터**.
 *
 * 목적: raw diarization_confidence(내부 모델 점수)를 외부 buyer 가 **필터링에 쓰는
 * 신뢰도 점수(filtering reliability score)** 로 변환한다. 전부 순수 함수(DB/IO 없음).
 *
 * ── 의미 고정(헷갈림 방지) ──────────────────────────────────────────────────
 *   - 출력은 **"정답 확률"이 아니다.** "화자 귀속이 얼마나 믿을 만한가"를 나타내는
 *     0.0~1.0 filtering reliability score 다. buyer 는 이 점수로 임계 필터링/제외에 쓴다.
 *   - **raw model score 를 그대로 노출하지 않는다.** 외부로 나가는 모든 점수는
 *     normalize(+penalty) 를 거친 reliability score 다. (내부 중간값만 raw 일 수 있음.)
 *   - 무효 입력은 **null(미상)** 로 둔다 — 0(확실히 낮음)과 구분한다. 잔존 불확실성은
 *     conflate 하지 않고 disclose: score=null + coverage 로 데이터 완전성을 별도 표기.
 *
 * ── D3 범위(골격) ───────────────────────────────────────────────────────────
 *   - normalizeConfidence(순수) + length-weighted 집계 + penalty 구조(미적용 기본).
 *   - confidence metadata 는 #52 `wrapExtension` envelope `{value,method,version,confidence}` 재사용.
 *   - **export 흐름 미배선**(export default behavior 변경 금지). 패키지 emit 은 후속 opt-in PR.
 *
 * ── 범위 밖(금지) ───────────────────────────────────────────────────────────
 *   D2 overlap / D4 pii_intervals / D5 acoustic masking 구현, migration/DB write,
 *   worker/GPU, Sync Integrity Gate 완화. raw score buyer 노출, 정답확률식 표현.
 */

import { wrapExtension, type UncountedExtension } from './baselineAdapter.js'

// ── buyer-facing 의미 상수 ──────────────────────────────────────────────────

export type FilteringReliabilityInterpretation = 'filtering_reliability_score'
export const FILTERING_RELIABILITY_INTERPRETATION: FilteringReliabilityInterpretation =
  'filtering_reliability_score'

/** buyer 문서용 설명(정답확률 아님 — 필터링 신뢰도). */
export const FILTERING_RELIABILITY_DESCRIPTION =
  'Speaker-attribution filtering reliability score in [0,1] (higher = more reliable). ' +
  'NOT a correctness probability. Intended for buyer-side filtering/exclusion thresholds. ' +
  'null = unknown (insufficient signal), distinct from 0 (low reliability).'

// ── normalize ──────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/**
 * raw diarization_confidence → buyer-facing reliability score.
 * - 유한 수치: [0,1] clamp.
 * - null/NaN/undefined/비수치(string/object 등): **null**(미상). 0 으로 강제하지 않는다.
 */
export function normalizeConfidence(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return clamp01(raw)
}

// ── penalty 구조(후보 — 기본 미적용) ────────────────────────────────────────

export type PenaltyName =
  | 'short_backchannel'
  | 'is_overlapping'
  | 'rapid_speaker_switch'
  | 'low_energy'
  | 'unclear_vad_boundary'

export const PENALTY_NAMES: readonly PenaltyName[] = [
  'short_backchannel',
  'is_overlapping',
  'rapid_speaker_switch',
  'low_energy',
  'unclear_vad_boundary',
]

/** penalty 가중치. 'not_configured' = 미설정(적용 안 함). 보수적 기본. */
export type PenaltyWeight = number | 'not_configured'
export type PenaltyConfig = Record<PenaltyName, PenaltyWeight>

/**
 * 기본 penalty config — **전부 not_configured**.
 * 검증되지 않은 가중치로 점수를 깎지 않는다(가짜 정밀도 방지). 실제 weight 는
 * 검증 후 별도로 주입한다.
 */
export const DEFAULT_PENALTY_CONFIG: PenaltyConfig = {
  short_backchannel: 'not_configured',
  is_overlapping: 'not_configured',
  rapid_speaker_switch: 'not_configured',
  low_energy: 'not_configured',
  unclear_vad_boundary: 'not_configured',
}

/**
 * penalty 후보 신호(발화 단위). true 면 해당 penalty 후보가 켜진 것.
 * ⚠️ 신호 출처(예: utterance_form.is_backchannel/has_overlap 등 §9)와의 매핑은
 *    **wiring PR 로 이연** — D3 골격은 신호 shape 만 받는다. (rapid_speaker_switch /
 *    low_energy / unclear_vad_boundary 는 현재 직접 산출원 부재.)
 */
export type PenaltySignals = Partial<Record<PenaltyName, boolean>>

export interface PenaltyOutcome {
  value: number
  applied: PenaltyName[]
  not_configured: PenaltyName[]
}

/**
 * 켜진 penalty 신호에 대해 config 가중치를 차감(있을 때만). [0,1] clamp.
 * config 가 not_configured/비수치면 적용하지 않고 not_configured 로 기록.
 * 기본 config 에서는 아무 것도 차감되지 않는다(base 그대로).
 */
export function applyPenalties(
  base: number,
  signals: PenaltySignals,
  config: PenaltyConfig = DEFAULT_PENALTY_CONFIG,
): PenaltyOutcome {
  let value = clamp01(base)
  const applied: PenaltyName[] = []
  const notConfigured: PenaltyName[] = []
  for (const name of PENALTY_NAMES) {
    if (signals[name] !== true) continue
    const w = config[name]
    if (typeof w !== 'number' || !Number.isFinite(w)) {
      notConfigured.push(name)
      continue
    }
    value = clamp01(value - w)
    applied.push(name)
  }
  return { value, applied, not_configured: notConfigured }
}

// ── session-level speaker_consistency_score ─────────────────────────────────

export interface UtteranceConfidenceInput {
  utterance_id: string
  /** raw diarization_confidence(0..1 기대). 무효면 점수 집계에서 제외(coverage 하락). */
  raw_confidence: unknown
  /** length 가중용. 무효/null 이면 단위 가중치(1.0). */
  duration_sec?: number | null
  penalty_signals?: PenaltySignals
}

export interface SpeakerConsistencyResult {
  /** 0..1 filtering reliability score. 유효 발화 0개면 null(미상). */
  score: number | null
  /** 집계 방식: 명시적으로 length-weighted mean 선택(보수적 percentile 변형은 향후 config). */
  aggregation_method: 'length_weighted_mean'
  interpretation: FilteringReliabilityInterpretation
  utterance_count: number
  /** 유효 raw confidence 보유 발화 수. */
  scored_count: number
  /** scored_count / utterance_count (데이터 완전성; score 의 meta-confidence 아님). */
  coverage: number
  penalties_applied_count: number
  penalties_not_configured: PenaltyName[]
}

/** length 가중치: 양의 유한 duration 이면 그 값, 아니면 단위 가중치 1.0. */
function lengthWeight(duration: number | null | undefined): number {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 1.0
}

/**
 * 발화별 normalized confidence 를 **length-weighted mean** 으로 세션 단위 집계.
 * - 무효 confidence 발화는 집계에서 제외(coverage 로 별도 공개).
 * - 유효 발화 0개(빈 입력 포함) → score=null, coverage=0 (0 아님 — 미상과 저신뢰 구분).
 * - penalty 는 기본(not_configured) 미적용.
 */
export function computeSpeakerConsistency(
  inputs: UtteranceConfidenceInput[],
  config: PenaltyConfig = DEFAULT_PENALTY_CONFIG,
): SpeakerConsistencyResult {
  let weightedSum = 0
  let weightTotal = 0
  let scored = 0
  let appliedCount = 0
  const notConfigured = new Set<PenaltyName>()

  for (const u of inputs) {
    const norm = normalizeConfidence(u.raw_confidence)
    if (norm === null) continue
    scored += 1
    const pen = applyPenalties(norm, u.penalty_signals ?? {}, config)
    appliedCount += pen.applied.length
    for (const n of pen.not_configured) notConfigured.add(n)
    const w = lengthWeight(u.duration_sec)
    weightedSum += pen.value * w
    weightTotal += w
  }

  const score = weightTotal > 0 ? clamp01(weightedSum / weightTotal) : null
  const utteranceCount = inputs.length
  const coverage = utteranceCount > 0 ? scored / utteranceCount : 0

  return {
    score,
    aggregation_method: 'length_weighted_mean',
    interpretation: FILTERING_RELIABILITY_INTERPRETATION,
    utterance_count: utteranceCount,
    scored_count: scored,
    coverage,
    penalties_applied_count: appliedCount,
    penalties_not_configured: [...notConfigured],
  }
}

// ── envelope emit (#52 wrapExtension 재사용) ────────────────────────────────

/**
 * speaker_consistency_score 를 uncounted_extensions envelope 로 감싼다.
 * envelope.confidence = null (점수의 meta-confidence 주장 안 함 — 데이터 완전성은
 * coverage 로 SpeakerConsistencyResult 에 별도). method/version = heuristic_mvp.
 */
export function toConsistencyExtension(score: number | null): UncountedExtension<number | null> {
  return wrapExtension(score, { method: 'heuristic_mvp', version: 'heuristic_mvp', confidence: null })
}
