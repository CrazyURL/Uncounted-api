/**
 * Overlap metadata (D2) — **value enhancer 메타데이터**(상품 생존 조건 아님).
 *
 * 목적: 발화 단위 화자 겹침(overlap) 인지 메타데이터를 baseline/extension 으로 구조화한다.
 * 전부 순수 함수(DB/IO 없음). **export 흐름 미배선**(default behavior 변경 금지).
 *
 * ── 위치(헷갈림 방지) ───────────────────────────────────────────────────────
 *   - overlap 은 **value enhancer · 차별화 요소**다. **상품 생존 조건이 아니다.**
 *     핵심 가치는 sync integrity · masking trust · transcript quality · metadata
 *     consistency 이고, overlap 은 그 위에 얹는 부가 메타데이터다.
 *   - 따라서 D2 는 **fail-closed 게이트로 승격하지 않는다.** overlap 산출 실패/부재가
 *     export 를 막아선 안 된다(이 모듈은 export 와 미배선이라 구조상 보장됨).
 *
 * ── 의미 고정 ────────────────────────────────────────────────────────────────
 *   - mono(단일 채널) 환경에서 **정확한 겹침 분리를 단정하지 않는다.** overlap 값은
 *     candidate(확률적·heuristic) 이며 disclosure 와 함께 제공한다. (OVERLAP_DISCLOSURE)
 *   - 3상태 분리(D3 의 null vs 0 과 동일 철학): `is_overlapping`
 *       - true  = 겹침 candidate 있음
 *       - false = 겹침 없음(명시 신호)
 *       - **null = unknown(판정 신호 부재)** — false 로 날조하지 않는다.
 *   - **현 코드 실측: `utterance_form` 에 `has_overlap` 필드가 없다**(extractor·migration·
 *     SPEC 어디에도 부재). 즉 현재 candidate source 가 **없다** → 기본 결과는 unknown.
 *     실제 신호 출처(pyannote overlap / VAD double-talk / utterance_form 확장)와의
 *     배선은 **wiring PR 로 이연**한다. D2 골격은 candidate shape 만 받는다.
 *
 * ── D2 범위(골격) ───────────────────────────────────────────────────────────
 *   - baseline `is_overlapping`(boolean|null) resolve(순수) + extension 구조
 *     (overlap_score / overlap_region / interruption_candidate).
 *   - extension envelope 는 #52 `wrapExtension` `{value,method,version,confidence}` 재사용.
 *   - `is_overlapping` 은 **baseline**(표준 boolean), 나머지 3개는 **uncounted_extensions**.
 *
 * ── 범위 밖(금지) ───────────────────────────────────────────────────────────
 *   pyannote overlap detection 신규 구현, VAD/double-talk DSP 신규 구현, overlap_score↔
 *   threshold 융합 판정(detection 로직), D4 pii_intervals / D5 acoustic masking,
 *   migration/DB write, worker/GPU, Sync Integrity Gate 완화, export default behavior 변경.
 *   D3 penalty 신호명 `is_overlapping` 과의 소비측 배선도 여기서 하지 않는다.
 */

import { wrapExtension, type UncountedExtension } from './baselineAdapter.js'

// ── buyer-facing disclosure 상수 ────────────────────────────────────────────

/** mono 한계 disclosure(정확한 겹침 분리 단정 금지). */
export const OVERLAP_DISCLOSURE =
  'Mono single-channel recording — exact speaker-overlap separation is NOT guaranteed. ' +
  'Overlap values are probabilistic candidates (heuristic), provided with residual ' +
  'probabilistic uncertainty disclosed. Overlap is a value-enhancer metadata, ' +
  'NOT a delivery survival condition and NOT a fail-closed gate.'

// ── candidate 신호 입력(후보 — 현재 산출원 부재) ────────────────────────────

/** overlap_region time span. emit surface(utterances.jsonl)와 동일하게 ms 단위. */
export interface OverlapTimeSpan {
  start_ms: number
  end_ms: number
}

/**
 * overlap candidate 신호(발화 단위). **현 코드에 산출원 없음** — wiring PR 에서
 * pyannote/VAD/utterance_form 확장 등과 매핑한다. 전부 optional, 부재면 unknown.
 */
export interface OverlapCandidateSignals {
  /** 명시적 겹침 여부 candidate. 없으면(undefined/null) unknown. */
  is_overlapping?: boolean | null
  /** 겹침 정도 0..1 candidate. */
  overlap_score?: number | null
  /** 겹침 구간 candidate. */
  overlap_region?: OverlapTimeSpan[] | null
  /** 끼어들기(interruption) candidate. */
  interruption_candidate?: boolean | null
}

// ── baseline is_overlapping resolve ─────────────────────────────────────────

export type OverlapSource = 'candidate_flag' | 'unknown'
export type OverlapMethod = 'heuristic_mvp' | 'not_available'

export interface IsOverlappingResolution {
  /** baseline boolean. **null = unknown**(신호 부재 — false 와 구분). */
  value: boolean | null
  source: OverlapSource
  method: OverlapMethod
}

/**
 * baseline `is_overlapping` 판정(순수).
 * - 명시 boolean candidate 가 있으면 그대로 사용(candidate_flag / heuristic_mvp).
 * - 없으면 **unknown**(value=null / not_available). false 로 날조하지 않는다.
 * - ⚠️ overlap_score + threshold 로 boolean 을 유도하지 않는다(detection 융합 로직 금지).
 *   score 는 extension 으로만 노출한다.
 */
export function resolveIsOverlapping(
  signals: OverlapCandidateSignals = {},
): IsOverlappingResolution {
  if (typeof signals.is_overlapping === 'boolean') {
    return { value: signals.is_overlapping, source: 'candidate_flag', method: 'heuristic_mvp' }
  }
  return { value: null, source: 'unknown', method: 'not_available' }
}

// ── extension wrappers (#52 wrapExtension 재사용) ───────────────────────────

function clamp01OrNull(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** 유효 OverlapTimeSpan[] 만 통과. 무효(비배열/항목 결함)면 null. */
function sanitizeRegions(regions: unknown): OverlapTimeSpan[] | null {
  if (!Array.isArray(regions)) return null
  const out: OverlapTimeSpan[] = []
  for (const r of regions) {
    if (!r || typeof r !== 'object') continue
    const s = (r as Record<string, unknown>).start_ms
    const e = (r as Record<string, unknown>).end_ms
    if (typeof s !== 'number' || typeof e !== 'number' || !Number.isFinite(s) || !Number.isFinite(e)) {
      continue
    }
    if (e < s) continue
    out.push({ start_ms: s, end_ms: e })
  }
  return out.length > 0 ? out : null
}

/**
 * overlap_score extension. score 무효면 value=null / method=not_available.
 * envelope.confidence = null(점수의 meta-confidence 주장 안 함 — candidate).
 */
export function toOverlapScoreExtension(score: unknown): UncountedExtension<number | null> {
  const v = clamp01OrNull(score)
  const method: OverlapMethod = v === null ? 'not_available' : 'heuristic_mvp'
  return wrapExtension(v, { method, version: method, confidence: null })
}

/** overlap_region extension. 무효면 value=null / method=not_available. */
export function toOverlapRegionExtension(
  regions: unknown,
): UncountedExtension<OverlapTimeSpan[] | null> {
  const v = sanitizeRegions(regions)
  const method: OverlapMethod = v === null ? 'not_available' : 'heuristic_mvp'
  return wrapExtension(v, { method, version: method, confidence: null })
}

/**
 * interruption_candidate extension. 명시 boolean 아니면 value=null / not_available.
 * (unknown 을 false 로 날조하지 않는다.)
 */
export function toInterruptionCandidateExtension(
  flag: unknown,
): UncountedExtension<boolean | null> {
  const v = typeof flag === 'boolean' ? flag : null
  const method: OverlapMethod = v === null ? 'not_available' : 'heuristic_mvp'
  return wrapExtension(v, { method, version: method, confidence: null })
}

// ── 통합 발화 단위 overlap 메타 ─────────────────────────────────────────────

export interface UtteranceOverlapMetadata {
  /** baseline 표준 boolean(null=unknown). */
  is_overlapping: boolean | null
  is_overlapping_source: OverlapSource
  /** uncounted_extensions 후보 3종(전부 envelope). */
  extensions: {
    overlap_score: UncountedExtension<number | null>
    overlap_region: UncountedExtension<OverlapTimeSpan[] | null>
    interruption_candidate: UncountedExtension<boolean | null>
  }
}

/**
 * candidate 신호 → 발화 단위 overlap 메타(baseline boolean + extension 3종).
 * 신호 전무(기본)면 is_overlapping=null(unknown), 모든 extension value=null.
 * **export 미배선** — 이 함수의 결과를 패키지에 emit 하는 것은 후속 wiring PR.
 * ⚠️ `OVERLAP_DISCLOSURE` 는 발화 단위에 싣지 않는다(노이즈) — manifest/readme emit 에서
 *    1회 소비하는 것을 wiring PR 에서 처리한다.
 */
export function buildUtteranceOverlapMetadata(
  signals: OverlapCandidateSignals = {},
): UtteranceOverlapMetadata {
  const resolved = resolveIsOverlapping(signals)
  return {
    is_overlapping: resolved.value,
    is_overlapping_source: resolved.source,
    extensions: {
      overlap_score: toOverlapScoreExtension(signals.overlap_score),
      overlap_region: toOverlapRegionExtension(signals.overlap_region),
      interruption_candidate: toInterruptionCandidateExtension(signals.interruption_candidate),
    },
  }
}
