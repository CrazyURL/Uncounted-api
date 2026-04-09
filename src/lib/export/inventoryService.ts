// ── SKU Inventory Service ───────────────────────────────────────────────
// SKU별 가용 BU 수, 시간, 화자 수, 라벨 커버리지, 품질 분포를 조회한다.

import { supabaseAdmin } from '../supabase.js'

// ── Types ───────────────────────────────────────────────────────────────

export interface SkuInventoryItem {
  skuId: string
  availableBUs: number
  totalHours: number
  speakerCount: number
  labelCoverage: number          // 0-1 ratio
  qualityDistribution: {
    A: number
    B: number
    C: number
  }
  consentedCount: number
  piiClearedCount: number
  withTranscriptCount: number
}

export interface InventorySummary {
  totalAvailableBUs: number
  totalHours: number
  totalSpeakers: number
  skus: SkuInventoryItem[]
  generatedAt: string
}

// ── SKU Definitions (minimal — maps to sku_presets) ─────────────────────

interface SkuFilter {
  minQaScore: number
  requireConsent: boolean
  requireTranscript: boolean
  qualityGrades?: string[]
}

const SKU_FILTERS: Record<string, SkuFilter> = {
  'U-A01': {
    minQaScore: 50,
    requireConsent: true,
    requireTranscript: true,
  },
  'U-A02': {
    minQaScore: 30,
    requireConsent: true,
    requireTranscript: false,
  },
  'U-B01': {
    minQaScore: 70,
    requireConsent: true,
    requireTranscript: true,
    qualityGrades: ['A', 'B'],
  },
}

// ── Core Function ───────────────────────────────────────────────────────

/**
 * Get inventory for all known SKUs.
 */
export async function getSkuInventory(): Promise<InventorySummary> {
  // Fetch all available BUs
  const { data: buRows, error } = await supabaseAdmin
    .from('billable_units')
    .select('id, session_id, user_id, quality_grade, qa_score, effective_seconds, has_labels, consent_status, pii_status, lock_status')
    .eq('lock_status', 'available')

  if (error) {
    throw new Error(`Failed to fetch BUs: ${error.message}`)
  }

  const allBUs = (buRows ?? []) as Record<string, unknown>[]

  // Fetch sessions with transcripts
  const sessionIds = [...new Set(allBUs.map((r) => r.session_id as string))]
  let sessionsWithTranscript = new Set<string>()

  if (sessionIds.length > 0) {
    const { data: tRows } = await supabaseAdmin
      .from('transcript_chunks')
      .select('session_id')
      .in('session_id', sessionIds)

    sessionsWithTranscript = new Set((tRows ?? []).map((r: Record<string, unknown>) => r.session_id as string))
  }

  // Calculate per-SKU inventory
  const skus: SkuInventoryItem[] = []

  for (const [skuId, filter] of Object.entries(SKU_FILTERS)) {
    const eligible = allBUs.filter((bu) => {
      if (Number(bu.qa_score ?? 0) < filter.minQaScore) return false
      if (filter.requireConsent && bu.consent_status !== 'PUBLIC_CONSENTED') return false
      if (filter.requireTranscript && !sessionsWithTranscript.has(bu.session_id as string)) return false
      if (filter.qualityGrades?.length && !filter.qualityGrades.includes(bu.quality_grade as string)) return false
      return true
    })

    const speakers = new Set(eligible.map((bu) => bu.user_id as string).filter(Boolean))
    const distribution = { A: 0, B: 0, C: 0 }
    let totalSeconds = 0
    let labeledCount = 0
    let consentedCount = 0
    let piiClearedCount = 0
    let withTranscriptCount = 0

    for (const bu of eligible) {
      const grade = bu.quality_grade as string
      if (grade in distribution) {
        distribution[grade as keyof typeof distribution]++
      }
      totalSeconds += Number(bu.effective_seconds ?? 0)
      if (bu.has_labels) labeledCount++
      if (bu.consent_status === 'PUBLIC_CONSENTED') consentedCount++
      if (bu.pii_status === 'CLEAR' || bu.pii_status === 'MASKED') piiClearedCount++
      if (sessionsWithTranscript.has(bu.session_id as string)) withTranscriptCount++
    }

    skus.push({
      skuId,
      availableBUs: eligible.length,
      totalHours: Math.round((totalSeconds / 3600) * 100) / 100,
      speakerCount: speakers.size,
      labelCoverage: eligible.length > 0
        ? Math.round((labeledCount / eligible.length) * 10000) / 10000
        : 0,
      qualityDistribution: distribution,
      consentedCount,
      piiClearedCount,
      withTranscriptCount,
    })
  }

  // Global totals
  const allSpeakers = new Set(allBUs.map((bu) => bu.user_id as string).filter(Boolean))
  const totalSeconds = allBUs.reduce((sum, bu) => sum + Number(bu.effective_seconds ?? 0), 0)

  return {
    totalAvailableBUs: allBUs.length,
    totalHours: Math.round((totalSeconds / 3600) * 100) / 100,
    totalSpeakers: allSpeakers.size,
    skus,
    generatedAt: new Date().toISOString(),
  }
}
