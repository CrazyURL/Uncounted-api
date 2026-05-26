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
  byCategory: Record<EmotionCategory, number> // resolved 기준 (manual + derived 합산)
  byCategoryManual: Record<EmotionCategory, number> // resolved + manual(gold) 만 — 게이트 category 균형 판정용
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
    byCategoryManual: emptyCategoryCounts(),
    byFineLabel: emptyFineCounts(),
  }
  for (const row of rows) {
    if (row.category_decision === 'resolved') {
      stats.resolvedTotal += 1
      if (row.category_source === 'manual') stats.resolvedManual += 1
      else if (row.category_source === 'derived') stats.resolvedDerived += 1
      if (isEmotionCategory(row.emotion_category)) {
        stats.byCategory[row.emotion_category] += 1
        // gold(manual) 만 별도 집계 — derived 가 category 균형 게이트를 부풀리지 않도록.
        if (row.category_source === 'manual') stats.byCategoryManual[row.emotion_category] += 1
      }
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
  // resolved/manual(gold) 의 category별 최소값. derived(자동파생) 는 제외 —
  // 자동파생이 category 균형을 부풀려 게이트가 gold 부족 상태에서 조기 통과하는 것을 막는다.
  return Math.min(
    stats.byCategoryManual.긍정,
    stats.byCategoryManual.중립,
    stats.byCategoryManual.부정,
  )
}

/**
 * §11.2 게이트 판정. manual(gold)·total·category 균형을 함께 본다.
 * category 균형은 gold(manual) 기준으로만 본다(derived 미포함).
 * E2 미만에서는 학습 파일럿 버튼 비활성(UI 책임, PR-H5).
 */
export function computeEmotionGate(stats: HumanLabelStats): GateResult {
  const allThreeCategories =
    stats.byCategoryManual.긍정 > 0 &&
    stats.byCategoryManual.중립 > 0 &&
    stats.byCategoryManual.부정 > 0

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

// ── 사람 수동 라벨 저장 (PR-H2a-api) ────────────────────────────────────────

export const LABEL_CONFIDENCES = ['high', 'medium', 'low'] as const
export function isLabelConfidence(v: unknown): v is (typeof LABEL_CONFIDENCES)[number] {
  return typeof v === 'string' && (LABEL_CONFIDENCES as readonly string[]).includes(v)
}

export interface HumanLabelInput {
  fine_label?: unknown
  emotion_category?: unknown
  category_decision?: unknown
  label_confidence?: unknown
  note?: unknown
}

export interface HumanLabelUpsertRow {
  utterance_id: string
  session_id: string
  label_type: 'emotion'
  fine_label: string | null
  emotion_category: string | null
  category_decision: CategoryDecision
  category_source: 'manual' | null
  label_confidence: string | null
  note: string | null
  labeler_id: string
  labeler_email: string | null
  updated_at: string
}

export interface HumanLabelUpsertContext {
  utteranceId: string
  sessionId: string
  labelerId: string
  labelerEmail?: string | null
}

/**
 * 관리자 수동 human-label 저장용 upsert row 빌드 + 검증 (DB CHECK 미러).
 * - category_source: resolved ⇒ 'manual', 그 외(pending_context/undecidable) ⇒ null.
 * - 반환: { error } (400 사유 문자열) 또는 { row }.
 * - utterances.emotion 은 본 경로가 절대 건드리지 않는다(별도 테이블만 write).
 */
export function buildHumanLabelUpsert(
  input: HumanLabelInput,
  ctx: HumanLabelUpsertContext,
  nowIso: string,
): { error: string } | { row: HumanLabelUpsertRow } {
  const fine_label = typeof input.fine_label === 'string' ? input.fine_label : null
  const emotion_category = typeof input.emotion_category === 'string' ? input.emotion_category : null
  const category_decision = input.category_decision
  const label_confidence = typeof input.label_confidence === 'string' ? input.label_confidence : null
  const note = typeof input.note === 'string' && input.note.length > 0 ? input.note : null

  if (!isCategoryDecision(category_decision)) return { error: 'invalid category_decision' }
  const category_source: 'manual' | null = category_decision === 'resolved' ? 'manual' : null

  const verr = validateHumanLabelRow({ fine_label, emotion_category, category_decision, category_source })
  if (verr) return { error: verr }
  if (label_confidence !== null && !isLabelConfidence(label_confidence)) {
    return { error: 'invalid label_confidence (high|medium|low)' }
  }

  return {
    row: {
      utterance_id: ctx.utteranceId,
      session_id: ctx.sessionId,
      label_type: 'emotion',
      fine_label,
      emotion_category,
      category_decision,
      category_source,
      label_confidence,
      note,
      labeler_id: ctx.labelerId,
      labeler_email: ctx.labelerEmail ?? null,
      updated_at: nowIso,
    },
  }
}
