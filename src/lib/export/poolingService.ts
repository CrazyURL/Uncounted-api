// ── BU Pooling & Ranking Service ────────────────────────────────────────
// DB에서 BU를 조회하고 SKU 적격성, 품질 게이트, 다양성 제약을 적용하여 랭킹한다.

import { supabaseAdmin } from '../supabase.js'

// ── Types ───────────────────────────────────────────────────────────────

export interface PoolingFilters {
  qualityGrades?: string[]      // 'A' | 'B' | 'C'
  dateFrom?: string             // YYYY-MM-DD
  dateTo?: string               // YYYY-MM-DD
  requireConsent?: boolean      // default true
  requirePiiCleaned?: boolean   // default true
  minQaScore?: number           // default 50
  requireTranscript?: boolean   // default true
  requireLabels?: boolean       // SKU별 라벨 필수 여부 (e.g. U-A02)
}

export interface DiversityConstraints {
  maxSpeakerRatio?: number  // max % of total from one speaker (default 0.4)
  minSpeakers?: number      // minimum distinct speakers (default 2)
  demographicTargets?: Record<string, Record<string, number>> // e.g. { gender: { male: 0.5, female: 0.5 } }
}

export interface QualityGate {
  minSnrDb?: number         // default 15
  minSpeechRatio?: number   // default 0.5
  maxClippingRatio?: number // default 0
  maxBeepMaskRatio?: number // default 0.3
}

export interface PooledBU {
  id: string
  sessionId: string
  minuteIndex: number
  userId: string | null
  qualityGrade: string
  qaScore: number
  qualityTier: string
  effectiveSeconds: number
  sessionDate: string
  hasLabels: boolean
  labelSource: string | null
  // quality metrics (from bu_quality_metrics join)
  snrDb: number | null
  speechRatio: number | null
  clippingRatio: number | null
  beepMaskRatio: number | null
  qualityScore: number | null
  // demographics (from sessions → users_profile join)
  ageBand?: string
  gender?: string
  regionGroup?: string
}

export interface PoolResult {
  selectedBUs: PooledBU[]
  canFulfill: boolean
  requested: number
  available: number
  shortfall: number
  speakerCount: number
  qualityDistribution: Record<string, number>
  summary: string
  demographicActual?: Record<string, Record<string, number>>
}

export interface PoolPreview {
  totalEligible: number
  totalHours: number
  speakerCount: number
  qualityDistribution: Record<string, number>
  labelCoverage: number      // ratio of BUs with labels
  avgQualityScore: number
}

// ── Default Constants ───────────────────────────────────────────────────

const DEFAULT_QUALITY_GATE: Required<QualityGate> = {
  minSnrDb: 15,
  minSpeechRatio: 0.5,
  maxClippingRatio: 0,
  maxBeepMaskRatio: 0.3,
}

const DEFAULT_DIVERSITY = {
  maxSpeakerRatio: 0.4,
  minSpeakers: 2,
} satisfies Omit<Required<DiversityConstraints>, 'demographicTargets'>

// ── Core Functions ──────────────────────────────────────────────────────

/**
 * Fetch all eligible BUs from DB, joining with bu_quality_metrics.
 */
async function fetchEligibleBUs(filters: PoolingFilters): Promise<PooledBU[]> {
  const requireConsent = filters.requireConsent ?? true
  const requirePii = filters.requirePiiCleaned ?? true
  const minQa = filters.minQaScore ?? 50
  const requireTranscript = filters.requireTranscript ?? true

  // Step 1: Query billable_units with base filters
  let query = supabaseAdmin
    .from('billable_units')
    .select('*')
    .eq('lock_status', 'available')

  if (requireConsent) {
    query = query.eq('consent_status', 'PUBLIC_CONSENTED')
  }
  if (requirePii) {
    query = query.in('pii_status', ['CLEAR', 'MASKED'])
  }
  if (minQa > 0) {
    query = query.gte('qa_score', minQa)
  }
  if (filters.qualityGrades?.length) {
    query = query.in('quality_grade', filters.qualityGrades)
  }
  if (filters.dateFrom) {
    query = query.gte('session_date', filters.dateFrom)
  }
  if (filters.dateTo) {
    query = query.lte('session_date', filters.dateTo)
  }
  if (filters.requireLabels) {
    query = query.eq('has_labels', true)
  }

  const { data: buRows, error: buError } = await query
  if (buError) {
    throw new Error(`Failed to fetch BUs: ${buError.message}`)
  }
  console.log(`[pooling] Step1: ${buRows?.length ?? 0} BUs after base filters (lock=available, consent, pii, qa>=${minQa})`)
  if (!buRows || buRows.length === 0) return []

  // Step 2: If transcript required, filter by sessions that have transcripts
  let eligibleSessionIds: Set<string> | null = null
  if (requireTranscript) {
    const sessionIds = [...new Set(buRows.map((r: Record<string, unknown>) => r.session_id as string))]
    const { data: transcriptRows, error: tError } = await supabaseAdmin
      .from('transcript_chunks')
      .select('session_id')
      .in('session_id', sessionIds)

    if (tError) {
      throw new Error(`Failed to check transcripts: ${tError.message}`)
    }
    eligibleSessionIds = new Set((transcriptRows ?? []).map((r: Record<string, unknown>) => r.session_id as string))
    console.log(`[pooling] Step2: ${eligibleSessionIds.size} sessions with transcripts (of ${sessionIds.length} total)`)
  }

  // Step 3: Fetch quality metrics for matching BUs
  const sessionIds = [...new Set(buRows.map((r: Record<string, unknown>) => r.session_id as string))]
  const { data: metricsRows } = await supabaseAdmin
    .from('bu_quality_metrics')
    .select('session_id, bu_index, snr_db, speech_ratio, clipping_ratio, beep_mask_ratio, quality_score')
    .in('session_id', sessionIds)

  // Build metrics lookup
  const metricsMap = new Map<string, Record<string, unknown>>()
  for (const m of (metricsRows ?? []) as Record<string, unknown>[]) {
    const key = `${m.session_id}_${m.bu_index}`
    metricsMap.set(key, m)
  }

  // Step 4: Fetch speaker demographics via sessions → users_profile
  const { data: profileRows } = await supabaseAdmin
    .from('sessions')
    .select('id, pid, users_profile(age_band, gender, region_group)')
    .in('id', sessionIds)

  const profileMap = new Map<string, { ageBand?: string; gender?: string; regionGroup?: string }>()
  for (const row of (profileRows ?? []) as Record<string, unknown>[]) {
    const profile = row.users_profile as Record<string, unknown> | null
    if (profile) {
      profileMap.set(row.id as string, {
        ageBand: (profile.age_band as string) ?? undefined,
        gender: (profile.gender as string) ?? undefined,
        regionGroup: (profile.region_group as string) ?? undefined,
      })
    }
  }

  // Step 5: Combine and filter
  const result: PooledBU[] = []
  for (const row of buRows as Record<string, unknown>[]) {
    const sessionId = row.session_id as string

    if (eligibleSessionIds && !eligibleSessionIds.has(sessionId)) continue

    const metricsKey = `${sessionId}_${row.minute_index}`
    const metrics = metricsMap.get(metricsKey)
    const demo = profileMap.get(sessionId)

    result.push({
      id: row.id as string,
      sessionId,
      minuteIndex: row.minute_index as number,
      userId: (row.user_id as string) ?? null,
      qualityGrade: row.quality_grade as string,
      qaScore: Number(row.qa_score ?? 0),
      qualityTier: row.quality_tier as string,
      effectiveSeconds: Number(row.effective_seconds ?? 0),
      sessionDate: row.session_date as string,
      hasLabels: (row.has_labels as boolean) ?? false,
      labelSource: (row.label_source as string) ?? null,
      snrDb: metrics ? Number(metrics.snr_db ?? null) : null,
      speechRatio: metrics ? Number(metrics.speech_ratio ?? null) : null,
      clippingRatio: metrics ? Number(metrics.clipping_ratio ?? null) : null,
      beepMaskRatio: metrics ? Number(metrics.beep_mask_ratio ?? null) : null,
      qualityScore: metrics ? Number(metrics.quality_score ?? null) : null,
      ageBand: demo?.ageBand,
      gender: demo?.gender,
      regionGroup: demo?.regionGroup,
    })
  }

  return result
}

/**
 * Apply quality gate filters.
 */
function applyQualityGate(bus: PooledBU[], gate: QualityGate): PooledBU[] {
  const g = { ...DEFAULT_QUALITY_GATE, ...gate }

  return bus.filter((bu) => {
    // BUs without metrics pass through (metrics may not be analyzed yet)
    if (bu.snrDb === null && bu.speechRatio === null) return true

    if (bu.snrDb !== null && bu.snrDb < g.minSnrDb) return false
    if (bu.speechRatio !== null && bu.speechRatio < g.minSpeechRatio) return false
    if (bu.clippingRatio !== null && bu.clippingRatio > g.maxClippingRatio) return false
    if (bu.beepMaskRatio !== null && bu.beepMaskRatio > g.maxBeepMaskRatio) return false

    return true
  })
}

// Demographic category → PooledBU field mapping
const DEMOGRAPHIC_FIELD_MAP: Record<string, keyof PooledBU> = {
  gender: 'gender',
  ageBand: 'ageBand',
  age_band: 'ageBand',
  regionGroup: 'regionGroup',
  region_group: 'regionGroup',
}

/**
 * Apply diversity constraints: max speaker ratio + min speakers + demographic targets.
 */
export function applyDiversityConstraints(
  ranked: PooledBU[],
  count: number,
  constraints: DiversityConstraints,
): { selected: PooledBU[]; demographicActual?: Record<string, Record<string, number>> } {
  const c = { ...DEFAULT_DIVERSITY, ...constraints }
  const maxPerSpeaker = Math.max(1, Math.floor(count * c.maxSpeakerRatio))
  const targets = c.demographicTargets

  // Initialize demographic slot tracking
  const slots: Record<string, Record<string, number>> = {}
  const filled: Record<string, Record<string, number>> = {}

  if (targets) {
    for (const [category, ratios] of Object.entries(targets)) {
      slots[category] = {}
      filled[category] = {}
      for (const [value, ratio] of Object.entries(ratios)) {
        slots[category][value] = Math.round(count * ratio)
        filled[category][value] = 0
      }
    }
  }

  const selected: PooledBU[] = []
  const speakerCounts = new Map<string, number>()

  for (const bu of ranked) {
    if (selected.length >= count) break

    // Speaker ratio check
    const speaker = bu.userId ?? '__unknown__'
    const currentCount = speakerCounts.get(speaker) ?? 0
    if (currentCount >= maxPerSpeaker) continue

    // Demographic slot check
    if (targets) {
      let canSelect = true
      for (const category of Object.keys(targets)) {
        const field = DEMOGRAPHIC_FIELD_MAP[category]
        const value = field ? (bu[field] as string | undefined) : undefined
        const bucket = value ?? '응답안함'

        // If this bucket has a target and is already full, skip
        if (slots[category][bucket] !== undefined && filled[category][bucket] >= slots[category][bucket]) {
          canSelect = false
          break
        }
      }
      if (!canSelect) continue
    }

    selected.push(bu)
    speakerCounts.set(speaker, currentCount + 1)

    // Update demographic filled counts
    if (targets) {
      for (const category of Object.keys(targets)) {
        const field = DEMOGRAPHIC_FIELD_MAP[category]
        const value = field ? (bu[field] as string | undefined) : undefined
        const bucket = value ?? '응답안함'
        if (filled[category][bucket] !== undefined) {
          filled[category][bucket]++
        } else {
          filled[category][bucket] = 1
        }
      }
    }
  }

  // Compute actual demographic ratios
  let demographicActual: Record<string, Record<string, number>> | undefined
  if (targets && selected.length > 0) {
    demographicActual = {}
    for (const [category, counts] of Object.entries(filled)) {
      demographicActual[category] = {}
      for (const [value, count_] of Object.entries(counts)) {
        demographicActual[category][value] = Math.round((count_ / selected.length) * 10000) / 10000
      }
    }
  }

  return { selected, demographicActual }
}

/**
 * Pool and rank BUs for a given SKU with filters and diversity constraints.
 */
export async function poolAndRankBUs(
  _skuId: string,
  requestedBUs: number,
  filters: PoolingFilters = {},
  qualityGate: QualityGate = {},
  diversityConstraints: DiversityConstraints = {},
): Promise<PoolResult> {
  // 1. Fetch all eligible BUs
  const allEligible = await fetchEligibleBUs(filters)

  // 2. Apply quality gate
  const gated = applyQualityGate(allEligible, qualityGate)

  // 3. Rank by quality_score descending (nulls last)
  const ranked = [...gated].sort((a, b) => {
    const scoreA = a.qualityScore ?? a.qaScore
    const scoreB = b.qualityScore ?? b.qaScore
    return scoreB - scoreA
  })

  // 4. Apply diversity constraints and select top N
  const { selected, demographicActual } = applyDiversityConstraints(ranked, requestedBUs, diversityConstraints)

  // 5. Build result
  const speakerSet = new Set(selected.map((bu) => bu.userId ?? '__unknown__'))
  const qualityDistribution: Record<string, number> = { A: 0, B: 0, C: 0 }
  for (const bu of selected) {
    qualityDistribution[bu.qualityGrade] = (qualityDistribution[bu.qualityGrade] ?? 0) + 1
  }

  const canFulfill = selected.length >= requestedBUs
  const shortfall = canFulfill ? 0 : requestedBUs - selected.length

  const summary = canFulfill
    ? `Selected ${selected.length} BUs from ${speakerSet.size} speakers`
    : `Short by ${shortfall} BUs (${selected.length}/${requestedBUs} available, ${speakerSet.size} speakers)`

  return {
    selectedBUs: selected,
    canFulfill,
    requested: requestedBUs,
    available: selected.length,
    shortfall,
    speakerCount: speakerSet.size,
    qualityDistribution,
    summary,
    demographicActual,
  }
}

/**
 * Preview pool: show eligible BU count, quality distribution, speaker count.
 */
export async function previewPool(
  _skuId: string,
  filters: PoolingFilters = {},
  qualityGate: QualityGate = {},
): Promise<PoolPreview> {
  const allEligible = await fetchEligibleBUs(filters)
  const gated = applyQualityGate(allEligible, qualityGate)

  const speakerSet = new Set(gated.map((bu) => bu.userId ?? '__unknown__'))
  const qualityDistribution: Record<string, number> = { A: 0, B: 0, C: 0 }
  let totalSeconds = 0
  let labeledCount = 0
  let totalScore = 0
  let scoredCount = 0

  for (const bu of gated) {
    qualityDistribution[bu.qualityGrade] = (qualityDistribution[bu.qualityGrade] ?? 0) + 1
    totalSeconds += bu.effectiveSeconds
    if (bu.hasLabels) labeledCount++
    if (bu.qualityScore !== null) {
      totalScore += bu.qualityScore
      scoredCount++
    }
  }

  return {
    totalEligible: gated.length,
    totalHours: Math.round((totalSeconds / 3600) * 100) / 100,
    speakerCount: speakerSet.size,
    qualityDistribution,
    labelCoverage: gated.length > 0 ? Math.round((labeledCount / gated.length) * 10000) / 10000 : 0,
    avgQualityScore: scoredCount > 0 ? Math.round((totalScore / scoredCount) * 100) / 100 : 0,
  }
}
