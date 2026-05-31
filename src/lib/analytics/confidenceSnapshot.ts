/**
 * PR-E1 — Confidence analytics snapshot helper.
 *
 * PR-D (#60) `computeLabelConfidenceTier` 의 룰을 admin endpoint 에서 재사용해
 * 코퍼스 전체 utterances 의 tier / source 분포 + 통계를 emit.
 *
 * 원칙:
 *   - **원문 0** — transcript_text 미사용. emotion_confidence / label_confidence 만.
 *   - **DB write 0** — pure read aggregation.
 *   - **PR-D helper 변경 0** — 본 모듈은 consumer.
 */

import {
  computeLabelConfidenceTier,
  type ConfidenceTier,
  type ConfidenceTierSource,
} from '../export/labelConfidenceTier.js'

export interface ConfidenceSnapshotInput {
  utterances: ReadonlyArray<{
    session_id: string
    label_confidence?: number | string | null
    emotion_confidence?: number | string | null
  }>
}

export interface ConfidenceStats {
  /** 측정 모집단 — emotion_confidence 가 유효한 utt 수 (mean/median 분모). */
  n: number
  mean: number | null
  median: number | null
  p25: number | null
  p75: number | null
  min: number | null
  max: number | null
}

export interface ConfidenceSessionBreakdown {
  /** Session id 첫 8자 + '…' (원문/PII 0). */
  id_prefix: string
  utt_total: number
  by_tier: Record<ConfidenceTier, number>
  needs_review_ratio: number
}

export interface ConfidenceSnapshot {
  total_sessions: number
  total_utterances_scanned: number
  by_tier: Record<ConfidenceTier, number>
  by_source: Record<ConfidenceTierSource, number>
  /** needs_review utterance / total. */
  needs_review_ratio: number
  /** emotion_confidence 통계 (label_confidence 100% null 현실 반영). */
  emotion_stats: ConfidenceStats
  /** label_confidence 통계 (현재는 거의 비어있음). */
  label_stats: ConfidenceStats
  /** needs_review_ratio 높은 순 top N. */
  session_breakdown: ReadonlyArray<ConfidenceSessionBreakdown>
}

const ID_PREFIX_LEN = 8
const TOP_SESSION_LIMIT = 50

function safePrefix(id: string): string {
  if (typeof id !== 'string') return '?…'
  return id.slice(0, ID_PREFIX_LEN) + '…'
}

function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.length === 0) return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function emptyStats(): ConfidenceStats {
  return { n: 0, mean: null, median: null, p25: null, p75: null, min: null, max: null }
}

function computeStats(values: number[]): ConfidenceStats {
  if (values.length === 0) return emptyStats()
  const sorted = [...values].sort((a, b) => a - b)
  const sum = values.reduce((a, b) => a + b, 0)
  const idx = (p: number) => Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return {
    n: values.length,
    mean: +(sum / values.length).toFixed(4),
    median: +sorted[Math.floor(sorted.length / 2)].toFixed(4),
    p25: +sorted[idx(0.25)].toFixed(4),
    p75: +sorted[idx(0.75)].toFixed(4),
    min: +sorted[0].toFixed(4),
    max: +sorted[sorted.length - 1].toFixed(4),
  }
}

export function buildConfidenceSnapshot(
  input: ConfidenceSnapshotInput,
  options?: { topLimit?: number },
): ConfidenceSnapshot {
  const limit = options?.topLimit ?? TOP_SESSION_LIMIT

  const bySession = new Map<string, { utt_total: number; by_tier: Record<ConfidenceTier, number> }>()
  const totalTier: Record<ConfidenceTier, number> = { high: 0, medium: 0, needs_review: 0 }
  const totalSource: Record<ConfidenceTierSource, number> = { label: 0, emotion: 0, none: 0 }
  const emoValues: number[] = []
  const labValues: number[] = []
  let totalUtt = 0

  for (const u of input.utterances) {
    const sid = typeof u.session_id === 'string' ? u.session_id : '__unknown__'
    let bucket = bySession.get(sid)
    if (!bucket) {
      bucket = { utt_total: 0, by_tier: { high: 0, medium: 0, needs_review: 0 } }
      bySession.set(sid, bucket)
    }
    bucket.utt_total += 1
    totalUtt += 1

    const r = computeLabelConfidenceTier({
      label_confidence: u.label_confidence,
      emotion_confidence: u.emotion_confidence,
    })
    bucket.by_tier[r.tier] += 1
    totalTier[r.tier] += 1
    totalSource[r.source] += 1

    const ec = toFiniteNumber(u.emotion_confidence)
    if (ec !== null) emoValues.push(ec)
    const lc = toFiniteNumber(u.label_confidence)
    if (lc !== null) labValues.push(lc)
  }

  const sessionRows: ConfidenceSessionBreakdown[] = []
  for (const [sid, b] of bySession) {
    const nr = b.by_tier.needs_review
    sessionRows.push({
      id_prefix: safePrefix(sid),
      utt_total: b.utt_total,
      by_tier: b.by_tier,
      needs_review_ratio: b.utt_total > 0 ? +(nr / b.utt_total).toFixed(4) : 0,
    })
  }
  sessionRows.sort((a, b) => b.needs_review_ratio - a.needs_review_ratio)

  return {
    total_sessions: bySession.size,
    total_utterances_scanned: totalUtt,
    by_tier: totalTier,
    by_source: totalSource,
    needs_review_ratio: totalUtt > 0 ? +(totalTier.needs_review / totalUtt).toFixed(4) : 0,
    emotion_stats: computeStats(emoValues),
    label_stats: computeStats(labValues),
    session_breakdown: sessionRows.slice(0, limit),
  }
}
