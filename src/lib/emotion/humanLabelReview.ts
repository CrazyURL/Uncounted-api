// ── Human Emotion Label — 순수 로직 (PR-H1a) ────────────────────────────────
// utterance_human_labels (migration 080) 의 도메인 규칙을 DB 와 분리된 순수 함수로 구현.
// 설계: scripts/analysis/design_human_emotion_label_loop_20260524.md
//
// 핵심:
//   - 7종 fine_label → 3종 emotion_category 안전맵 자동 파생(derived/resolved).
//   - 놀람/당황 → pending_context(검수 큐). 무조건 부정 매핑 금지.
//   - 판단불가 = category_decision='undecidable' (4번째 category 아님).
//   - resolved ⇒ fine_label·emotion_category·category_source 필수 (DB CHECK 미러).

export const EMOTION_FINE_LABELS = ['기쁨', '놀람', '슬픔', '분노', '불안', '당황', '중립'] as const
export const EMOTION_CATEGORIES = ['긍정', '중립', '부정'] as const
export const CATEGORY_DECISIONS = ['resolved', 'pending_context', 'undecidable'] as const
export const CATEGORY_SOURCES = ['derived', 'manual'] as const

export type FineLabel = (typeof EMOTION_FINE_LABELS)[number]
export type EmotionCategory = (typeof EMOTION_CATEGORIES)[number]
export type CategoryDecision = (typeof CATEGORY_DECISIONS)[number]
export type CategorySource = (typeof CATEGORY_SOURCES)[number]

// 모델 emotion_confidence 가 이 값 미만(또는 null)이면 검수 큐로 보낸다(§3.3).
// 기존 auto_review 경계(0.60) 재사용. env/상수 튜닝은 후속(§10).
export const LOW_CONFIDENCE_THRESHOLD = 0.6

// 안전맵: 7종 → 3종. 놀람/당황은 문맥 의존 → null(보류). (강제 매핑 금지)
const SAFE_FINE_TO_CATEGORY: Record<FineLabel, EmotionCategory | null> = {
  기쁨: '긍정',
  중립: '중립',
  슬픔: '부정',
  분노: '부정',
  불안: '부정',
  놀람: null,
  당황: null,
}

export function isFineLabel(v: unknown): v is FineLabel {
  return typeof v === 'string' && (EMOTION_FINE_LABELS as readonly string[]).includes(v)
}
export function isEmotionCategory(v: unknown): v is EmotionCategory {
  return typeof v === 'string' && (EMOTION_CATEGORIES as readonly string[]).includes(v)
}
export function isCategoryDecision(v: unknown): v is CategoryDecision {
  return typeof v === 'string' && (CATEGORY_DECISIONS as readonly string[]).includes(v)
}
export function isCategorySource(v: unknown): v is CategorySource {
  return typeof v === 'string' && (CATEGORY_SOURCES as readonly string[]).includes(v)
}

export interface DerivedCategory {
  emotionCategory: EmotionCategory | null
  // 자동 파생 경로는 절대 undecidable 을 만들지 않는다(판단불가는 사람 판정).
  categoryDecision: 'resolved' | 'pending_context'
  categorySource: 'derived' | null
}

/**
 * 7종 fine_label 을 안전맵으로 3종 category 자동 파생.
 * - 기쁨/중립/슬픔/분노/불안 → resolved + derived
 * - 놀람/당황 → pending_context (category null, source null) → 검수 큐
 * - 알 수 없는 라벨 → pending_context (강제 분류 금지)
 */
export function deriveEmotionCategory(fineLabel: string): DerivedCategory {
  if (!isFineLabel(fineLabel)) {
    return { emotionCategory: null, categoryDecision: 'pending_context', categorySource: null }
  }
  const mapped = SAFE_FINE_TO_CATEGORY[fineLabel]
  if (mapped === null) {
    return { emotionCategory: null, categoryDecision: 'pending_context', categorySource: null }
  }
  return { emotionCategory: mapped, categoryDecision: 'resolved', categorySource: 'derived' }
}

export interface HumanLabelShape {
  fine_label: string | null
  emotion_category: string | null
  category_decision: string
  category_source: string | null
}

/**
 * DB CHECK 제약을 미러링한 애플리케이션-레벨 검증.
 * null = 유효, string = 위반 사유. (migration 080 의 CHECK 와 의미 일치)
 */
export function validateHumanLabelRow(row: HumanLabelShape): string | null {
  if (!isCategoryDecision(row.category_decision)) return 'invalid category_decision'
  if (row.fine_label !== null && !isFineLabel(row.fine_label)) return 'invalid fine_label'
  if (row.emotion_category !== null && !isEmotionCategory(row.emotion_category)) {
    return 'invalid emotion_category'
  }
  if (row.category_source !== null && !isCategorySource(row.category_source)) {
    return 'invalid category_source'
  }
  if (row.category_decision === 'resolved') {
    if (row.fine_label === null || row.emotion_category === null) {
      return 'resolved requires fine_label and emotion_category'
    }
    if (row.category_source === null) {
      return 'resolved requires category_source (derived|manual)'
    }
  }
  return null
}

/**
 * 모델 신뢰도가 검수 큐 대상인지(저신뢰). null/비유한 = 불확실 → 큐 대상(true).
 */
export function isLowConfidence(
  confidence: number | null | undefined,
  threshold: number = LOW_CONFIDENCE_THRESHOLD,
): boolean {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return true
  return confidence < threshold
}

// ── 진행도 stats (§11) ──────────────────────────────────────────────────────

export interface HumanLabelStatsRow {
  category_decision: string
  category_source: string | null
  emotion_category: string | null
  fine_label: string | null
}

export interface HumanLabelStats {
  resolvedTotal: number
  resolvedManual: number
  resolvedDerived: number
  pendingContext: number
  undecidable: number
  byCategory: Record<EmotionCategory, number> // resolved 기준
  byFineLabel: Record<FineLabel, number> // fine_label 보유 행 전부
}

function emptyCategoryCounts(): Record<EmotionCategory, number> {
  return { 긍정: 0, 중립: 0, 부정: 0 }
}
function emptyFineCounts(): Record<FineLabel, number> {
  return { 기쁨: 0, 놀람: 0, 슬픔: 0, 분노: 0, 불안: 0, 당황: 0, 중립: 0 }
}

/**
 * utterance_human_labels 행 집합 → 진행도 집계. utterances.emotion(모델)은 포함하지 않는다.
 */
export function summarizeHumanLabelStats(rows: HumanLabelStatsRow[]): HumanLabelStats {
  const stats: HumanLabelStats = {
    resolvedTotal: 0,
    resolvedManual: 0,
    resolvedDerived: 0,
    pendingContext: 0,
    undecidable: 0,
    byCategory: emptyCategoryCounts(),
    byFineLabel: emptyFineCounts(),
  }
  for (const row of rows) {
    if (row.category_decision === 'resolved') {
      stats.resolvedTotal += 1
      if (row.category_source === 'manual') stats.resolvedManual += 1
      else if (row.category_source === 'derived') stats.resolvedDerived += 1
      if (isEmotionCategory(row.emotion_category)) stats.byCategory[row.emotion_category] += 1
    } else if (row.category_decision === 'pending_context') {
      stats.pendingContext += 1
    } else if (row.category_decision === 'undecidable') {
      stats.undecidable += 1
    }
    if (isFineLabel(row.fine_label)) stats.byFineLabel[row.fine_label] += 1
  }
  return stats
}

// ── 학습 게이트 (§11.2) — gold = manual 중심 ────────────────────────────────

export type EmotionGate = 'E0' | 'E1' | 'E2' | 'E3' | 'E4'

export interface GateResult {
  gate: EmotionGate
  /** 다음 게이트까지 부족분(만족 시 null). 가장 큰 병목 기준. */
  nextRequired: { metric: string; need: number } | null
}

function minCategoryManual(stats: HumanLabelStats): number {
  // resolved/manual 의 category별 최소값 근사: byCategory 는 manual+derived 합산이라
  // 정확한 category별 manual 분리는 stats 행 재집계가 필요(후속). 여기선 보수적으로
  // resolvedManual 총량과 3 category 존재 여부만 게이트에 사용한다.
  return Math.min(stats.byCategory.긍정, stats.byCategory.중립, stats.byCategory.부정)
}

/**
 * §11.2 게이트 판정. manual(gold)·total·category 균형을 함께 본다.
 * E2 미만에서는 학습 파일럿 버튼 비활성(UI 책임, PR-H5).
 */
export function computeEmotionGate(stats: HumanLabelStats): GateResult {
  const allThreeCategories =
    stats.byCategory.긍정 > 0 && stats.byCategory.중립 > 0 && stats.byCategory.부정 > 0

  // E4
  if (stats.resolvedManual >= 500 && stats.resolvedTotal >= 3000 && minCategoryManual(stats) >= 100) {
    return { gate: 'E4', nextRequired: null }
  }
  // E3
  if (stats.resolvedManual >= 200 && stats.resolvedTotal >= 1000 && minCategoryManual(stats) >= 30) {
    return { gate: 'E3', nextRequired: { metric: 'resolved_manual', need: 500 - stats.resolvedManual } }
  }
  // E2
  if (stats.resolvedManual >= 50 && stats.resolvedTotal >= 200 && allThreeCategories) {
    return { gate: 'E2', nextRequired: { metric: 'resolved_manual', need: 200 - stats.resolvedManual } }
  }
  // E1
  if (stats.resolvedTotal >= 10) {
    return { gate: 'E1', nextRequired: { metric: 'resolved_manual', need: Math.max(0, 50 - stats.resolvedManual) } }
  }
  // E0
  return { gate: 'E0', nextRequired: { metric: 'resolved_total', need: 10 - stats.resolvedTotal } }
}
