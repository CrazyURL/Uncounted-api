/**
 * PR-E1 — Preflight analytics snapshot helper.
 *
 * PR-A (#58) `transcript-pattern-detector` 의 5 카테고리 정규식을 admin endpoint
 * 에서 재사용해 코퍼스 전체 sweep 결과를 집계한다.
 *
 * 원칙:
 *   - **원문 0** — 입력 transcript 는 detector 로만 흘러 카운트만 산출, 외부 노출 0.
 *   - **DB write 0** — pure read aggregation.
 *   - **PR-A detector 변경 0** — 본 모듈은 consumer.
 *
 * 본 helper 는 detector + utterance list 를 받아 카테고리×count + per-session
 * breakdown 을 emit. supabase 호출은 route 측에서 수행 (테스트 격리).
 */

import {
  detectTranscriptPatterns,
  type TranscriptPatternCategory,
} from '../export/transcript-pattern-detector.js'

export interface PreflightSnapshotInput {
  utterances: ReadonlyArray<{
    session_id: string
    transcript_text: string | null | undefined
  }>
}

export type RiskTier = 'tier_0_clean' | 'tier_1_review' | 'tier_2_blocked'

const TIER_2_CATEGORIES: ReadonlyArray<TranscriptPatternCategory> = [
  'credential_like',
  'foreign_id_like',
  'payment_like',
  'numeric_sensitive_like',
]

const ZERO_CATEGORIES = (): Record<TranscriptPatternCategory, number> => ({
  credential_like: 0,
  foreign_id_like: 0,
  payment_like: 0,
  korean_name_like: 0,
  numeric_sensitive_like: 0,
})

export interface PreflightSessionBreakdown {
  /** Session id 첫 8자 + '…' (원문/PII 0). */
  id_prefix: string
  utt_total: number
  utt_dirty: number
  dirty_pct: number
  categories: Record<TranscriptPatternCategory, number>
  /** Tier-0 clean / Tier-1 review / Tier-2 blocked. */
  risk_tier: RiskTier
}

export interface PreflightSnapshot {
  total_sessions: number
  total_utterances_scanned: number
  clean_utt: number
  dirty_utt: number
  clean_ratio: number
  dirty_ratio: number
  hits_by_category: Record<TranscriptPatternCategory, number>
  sessions_by_risk_tier: Record<RiskTier, number>
  /** 위험도 높은 순 (utt_dirty desc, dirty_pct tiebreak) top N. */
  top_sessions: ReadonlyArray<PreflightSessionBreakdown>
}

const ID_PREFIX_LEN = 8
const TOP_SESSION_LIMIT = 50

function classifyRiskTier(
  categories: Record<TranscriptPatternCategory, number>,
): RiskTier {
  for (const c of TIER_2_CATEGORIES) {
    if (categories[c] > 0) return 'tier_2_blocked'
  }
  if (categories.korean_name_like > 0) return 'tier_1_review'
  return 'tier_0_clean'
}

function safePrefix(id: string): string {
  if (typeof id !== 'string') return '?…'
  return id.slice(0, ID_PREFIX_LEN) + '…'
}

export function buildPreflightSnapshot(
  input: PreflightSnapshotInput,
  options?: { topLimit?: number },
): PreflightSnapshot {
  const limit = options?.topLimit ?? TOP_SESSION_LIMIT
  const bySession = new Map<
    string,
    { utt_total: number; utt_dirty: number; categories: Record<TranscriptPatternCategory, number> }
  >()
  const totalCategories = ZERO_CATEGORIES()
  let totalUtt = 0
  let totalDirty = 0

  for (const u of input.utterances) {
    const sid = typeof u.session_id === 'string' ? u.session_id : '__unknown__'
    let bucket = bySession.get(sid)
    if (!bucket) {
      bucket = { utt_total: 0, utt_dirty: 0, categories: ZERO_CATEGORIES() }
      bySession.set(sid, bucket)
    }
    bucket.utt_total += 1
    totalUtt += 1

    const text = typeof u.transcript_text === 'string' ? u.transcript_text : ''
    if (text.length === 0) continue

    const r = detectTranscriptPatterns(text)
    if (r.totalHits > 0) {
      bucket.utt_dirty += 1
      totalDirty += 1
      for (const c of Object.keys(r.hitsByCategory) as TranscriptPatternCategory[]) {
        bucket.categories[c] += r.hitsByCategory[c]
        totalCategories[c] += r.hitsByCategory[c]
      }
    }
  }

  const sessionRows: PreflightSessionBreakdown[] = []
  const tierCounts: Record<RiskTier, number> = {
    tier_0_clean: 0,
    tier_1_review: 0,
    tier_2_blocked: 0,
  }
  for (const [sid, b] of bySession) {
    const tier = classifyRiskTier(b.categories)
    tierCounts[tier] += 1
    sessionRows.push({
      id_prefix: safePrefix(sid),
      utt_total: b.utt_total,
      utt_dirty: b.utt_dirty,
      dirty_pct: b.utt_total > 0 ? +((b.utt_dirty / b.utt_total) * 100).toFixed(2) : 0,
      categories: b.categories,
      risk_tier: tier,
    })
  }

  sessionRows.sort((a, b) => {
    if (b.utt_dirty !== a.utt_dirty) return b.utt_dirty - a.utt_dirty
    return b.dirty_pct - a.dirty_pct
  })

  const cleanRatio = totalUtt > 0 ? +((totalUtt - totalDirty) / totalUtt).toFixed(4) : 0
  const dirtyRatio = totalUtt > 0 ? +(totalDirty / totalUtt).toFixed(4) : 0

  return {
    total_sessions: bySession.size,
    total_utterances_scanned: totalUtt,
    clean_utt: totalUtt - totalDirty,
    dirty_utt: totalDirty,
    clean_ratio: cleanRatio,
    dirty_ratio: dirtyRatio,
    hits_by_category: totalCategories,
    sessions_by_risk_tier: tierCounts,
    top_sessions: sessionRows.slice(0, limit),
  }
}
