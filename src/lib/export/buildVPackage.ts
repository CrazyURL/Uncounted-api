// ── BM v10.0 v-aware Package Builder — 4단계 SKU 분리 ──────────────────
//
// 약관 v1.1 정합:
//   - 제2조: 데이터 버전 v + 신선도 차등 (vN > vN-1 > vN-3)
//   - 제10조 1항: 600h 단위 자동 분리 + 비독점 N회 5~10회 + 신선도 단가 차등
//   - 제10조 2항: 4단계 SKU (UC-A1 시드 6h / A2 60h·600h / A3 6,000h / LLM)
//
// 기존 packageBuilder.ts (1125줄)와 분리:
//   - packageBuilder: 세션·BU 기반 패키지 (legacy + v9.x 호환)
//   - buildVPackage:  v 코호트 기반 패키지 (BM v10.0 신규 path)
//
// 본 모듈은 v 단위 분배 로직과 정합. 분배는 distributeVRevenue.ts.

import { supabaseAdmin } from '../supabase.js'

// 상수 inline — packageBuilder.ts와 동기 유지 필요 (약관·migration 갱신 시 함께)
// packageBuilder import 시 s3.ts env 검증이 transitive trigger되어 테스트 환경 분리.
const DATA_SCHEMA_VERSION = '2.0'
const DATA_LICENSE = 'Uncounted Data License v2'

// ── BM v10.0 4단계 SKU 정의 ─────────────────────────────────────────────
export type SkuTier = 'UC-A1' | 'UC-A2' | 'UC-A3' | 'UC-LLM'

export interface SkuTierSpec {
  /** SKU tier 코드 */
  tier: SkuTier
  /** 표준 시간 단위 (h) — 약관 v1.1 제10조 2항 */
  standardHours: number
  /** 단가 범위 (KRW/h) — 시장 검증 후 정식 (약관 v1.1 제10조 3항) */
  priceRangeKrwPerHour: { min: number; max: number }
  /** 비독점 N회 판매 상한 (약관 v1.1 제10조 1항) */
  maxSoldCount: number
  /** 단계 진입 가입자 수 */
  enrollmentRange: { min: number; max: number }
  /** 단계 진입 시기 (M = 월) */
  monthRange: { start: number; end: number }
  /** 설명 */
  description: string
}

export const SKU_TIER_SPECS: Record<SkuTier, SkuTierSpec> = {
  'UC-A1': {
    tier: 'UC-A1',
    standardHours: 6,
    priceRangeKrwPerHour: { min: 100_000 / 6, max: 500_000 / 6 },  // 건당 ₩100K~₩500K
    maxSoldCount: 1,
    enrollmentRange: { min: 20, max: 100 },
    monthRange: { start: 0, end: 6 },
    description: '시드 단계 — 6h 파일럿 (무료 검증 미끼)',
  },
  'UC-A2': {
    tier: 'UC-A2',
    standardHours: 60,
    priceRangeKrwPerHour: { min: 200_000, max: 600_000 },
    maxSoldCount: 6,
    enrollmentRange: { min: 100, max: 100_000 },
    monthRange: { start: 3, end: 24 },
    description: '초기/성장 단계 — 60h 트라이얼 또는 600h 정기',
  },
  'UC-A3': {
    tier: 'UC-A3',
    standardHours: 6_000,
    priceRangeKrwPerHour: { min: 600_000, max: 2_000_000 },
    maxSoldCount: 10,
    enrollmentRange: { min: 100_000, max: 1_000_000 },
    monthRange: { start: 24, end: Number.POSITIVE_INFINITY },
    description: '규모 단계 — 6,000h 대량 (희소 데이터)',
  },
  'UC-LLM': {
    tier: 'UC-LLM',
    standardHours: 6_000,
    priceRangeKrwPerHour: { min: 1_000_000, max: 2_000_000 },
    maxSoldCount: 10,
    enrollmentRange: { min: 1_000_000, max: Number.POSITIVE_INFINITY },
    monthRange: { start: 24, end: Number.POSITIVE_INFINITY },
    description: '4세대 — Instruction Tuning Data (자동 분류·요약·QA)',
  },
}

/**
 * 가입자 수 + 누적 양자 동의 시간 → 적정 SKU tier 자동 추천.
 * 약관 v1.1 제10조 2항 (가입자 수 기반 자동 단계 승급) 정합.
 */
export function recommendSkuTier(
  enrollmentCount: number,
  totalConsentedHours: number,
): SkuTier {
  // 가장 큰 단계부터 우선 매칭 (조건 충족 시)
  if (enrollmentCount >= SKU_TIER_SPECS['UC-LLM'].enrollmentRange.min &&
      totalConsentedHours >= SKU_TIER_SPECS['UC-LLM'].standardHours) {
    return 'UC-LLM'
  }
  if (enrollmentCount >= SKU_TIER_SPECS['UC-A3'].enrollmentRange.min &&
      totalConsentedHours >= SKU_TIER_SPECS['UC-A3'].standardHours) {
    return 'UC-A3'
  }
  if (enrollmentCount >= SKU_TIER_SPECS['UC-A2'].enrollmentRange.min &&
      totalConsentedHours >= SKU_TIER_SPECS['UC-A2'].standardHours) {
    return 'UC-A2'
  }
  return 'UC-A1'
}

/**
 * v 표준 단위 검증 — UC-A1 6h / UC-A2 60·600h / UC-A3 6,000h.
 * 시드 단계는 6h 미만도 허용 (운영 유연성).
 */
export function validateVSize(tier: SkuTier, totalHours: number): {
  valid: boolean
  reason?: string
} {
  const spec = SKU_TIER_SPECS[tier]
  // UC-A1: 6h 표준이지만 시드 단계 유연성으로 1h~10h 허용
  if (tier === 'UC-A1') {
    return totalHours >= 1 && totalHours <= 10
      ? { valid: true }
      : { valid: false, reason: `UC-A1 시드 1~10h 범위, 입력=${totalHours}h` }
  }
  // UC-A2: 60h 또는 600h (트라이얼 vs 정기)
  if (tier === 'UC-A2') {
    if (Math.abs(totalHours - 60) <= 6 || Math.abs(totalHours - 600) <= 60) {
      return { valid: true }
    }
    return { valid: false, reason: `UC-A2 60h±10% 또는 600h±10%, 입력=${totalHours}h` }
  }
  // UC-A3 / UC-LLM: 6,000h ±10%
  if (Math.abs(totalHours - spec.standardHours) > spec.standardHours * 0.1) {
    return {
      valid: false,
      reason: `${tier} ${spec.standardHours}h±10%, 입력=${totalHours}h`,
    }
  }
  return { valid: true }
}

// ── v Package Manifest (약관 v1.1 제2조 + 제10조) ──────────────────────
export interface VPackageManifest {
  // root metadata
  schemaVersion: string
  versionId: string
  versionNumber: number
  skuTier: SkuTier
  exportDate: string
  buyerId: string | null

  // 코호트 정보 (약관 v1.1 제2조 정의 + 제10조 1항 동질성)
  cohort: {
    periodStart: string
    periodEnd: string
    totalHours: number
    contributorCount: number
    familyPct: number | null
    friendPct: number | null
    businessPct: number | null
  }

  // 신선도 차등 (vN > vN-1 > vN-3)
  freshness: {
    quartile: 1 | 2 | 3 | 4
    label: '최신 (프리미엄)' | '직전' | '중간' | '오래 (할인)'
  }

  // 비독점 N회 (약관 v1.1 제10조 1항)
  exclusivity: {
    soldCount: number
    maxSoldCount: number
    remainingSlots: number
  }

  license: string
  // 분배 알고리즘 메타 — 사용자 신뢰 (약관 v1.1 제13조 5항)
  distributionAlgorithm: {
    version: 'v0.6'
    formula: '순이익 50:50 + 선가입자 우선 + Cap ₩300만 + 잉여 이월'
  }
}

const FRESHNESS_LABEL: Record<1 | 2 | 3 | 4, VPackageManifest['freshness']['label']> = {
  1: '최신 (프리미엄)',
  2: '직전',
  3: '중간',
  4: '오래 (할인)',
}

type VersionRow = {
  version_id: string
  version_number: number
  cohort_period_start: string
  cohort_period_end: string
  total_hours: number
  freshness_quartile: 1 | 2 | 3 | 4
  status: string
  sku_tier: SkuTier
  family_pct: number | null
  friend_pct: number | null
  business_pct: number | null
  sold_count: number
  max_sold_count: number
}

/**
 * v 1건의 manifest 빌드 — packageBuilder export 시 root 메타로 박힘.
 *
 * 약관 v1.1 제10조: 4단계 SKU + 신선도 차등 + 비독점 N회.
 * 약관 v1.1 제13조 5항: 분배 알고리즘 투명 공개.
 */
export async function buildVManifest(
  versionId: string,
  buyerId: string | null,
): Promise<VPackageManifest> {
  // v 정보 조회
  const { data: version, error: vErr } = await supabaseAdmin
    .from('data_versions')
    .select(
      'version_id, version_number, cohort_period_start, cohort_period_end, ' +
      'total_hours, freshness_quartile, status, sku_tier, ' +
      'family_pct, friend_pct, business_pct, sold_count, max_sold_count',
    )
    .eq('version_id', versionId)
    .single<VersionRow>()
  if (vErr || !version) {
    throw new Error(`Version not found: ${versionId} (${vErr?.message ?? ''})`)
  }

  // 표준 단위 검증
  const sizeCheck = validateVSize(version.sku_tier, Number(version.total_hours))
  if (!sizeCheck.valid) {
    throw new Error(`v size 검증 실패: ${sizeCheck.reason}`)
  }

  // contributor count
  const { count: contributorCount, error: cErr } = await supabaseAdmin
    .from('version_contributors')
    .select('id', { count: 'exact', head: true })
    .eq('version_id', versionId)
  if (cErr) {
    throw new Error(`contributor count failed: ${cErr.message}`)
  }

  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    versionId: version.version_id,
    versionNumber: version.version_number,
    skuTier: version.sku_tier,
    exportDate: new Date().toISOString(),
    buyerId,
    cohort: {
      periodStart: version.cohort_period_start,
      periodEnd: version.cohort_period_end,
      totalHours: Number(version.total_hours),
      contributorCount: contributorCount ?? 0,
      familyPct: version.family_pct,
      friendPct: version.friend_pct,
      businessPct: version.business_pct,
    },
    freshness: {
      quartile: version.freshness_quartile,
      label: FRESHNESS_LABEL[version.freshness_quartile],
    },
    exclusivity: {
      soldCount: version.sold_count,
      maxSoldCount: version.max_sold_count,
      remainingSlots: Math.max(version.max_sold_count - version.sold_count, 0),
    },
    license: DATA_LICENSE,
    distributionAlgorithm: {
      version: 'v0.6',
      formula: '순이익 50:50 + 선가입자 우선 + Cap ₩300만 + 잉여 이월',
    },
  }
}

/**
 * v 판매 완료 후 sold_count 증가 + 한도 도달 시 archived 전환.
 * 신선도 재산정은 admin-rewards 측 분기 결산 시 일괄 처리.
 *
 * @returns 새 sold_count / archived 여부
 */
export async function recordVSale(versionId: string): Promise<{
  soldCount: number
  archived: boolean
}> {
  const { data: version, error: vErr } = await supabaseAdmin
    .from('data_versions')
    .select('sold_count, max_sold_count')
    .eq('version_id', versionId)
    .single<{ sold_count: number; max_sold_count: number }>()
  if (vErr || !version) {
    throw new Error(`Version not found: ${versionId}`)
  }

  const newSoldCount = version.sold_count + 1
  const archived = newSoldCount >= version.max_sold_count

  const { error: uErr } = await supabaseAdmin
    .from('data_versions')
    .update({
      sold_count: newSoldCount,
      status: archived ? 'archived' : 'sold',
      archived_at: archived ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('version_id', versionId)
  if (uErr) {
    throw new Error(`recordVSale failed: ${uErr.message}`)
  }

  return { soldCount: newSoldCount, archived }
}

/**
 * 시드 단계용 빠른 v 생성 — 600h 미달이지만 6h/60h 단위로 강제 sealed.
 * 시드 20명 파일럿 (UC-A1 6h)부터 즉시 판매 가능하도록.
 */
export async function createSeedV(input: {
  totalHours: number
  skuTier: 'UC-A1' | 'UC-A2'
  cohortPeriodStart: string
  cohortPeriodEnd: string
}): Promise<{ versionId: string; versionNumber: number }> {
  // 표준 단위 검증
  const sizeCheck = validateVSize(input.skuTier, input.totalHours)
  if (!sizeCheck.valid) {
    throw new Error(`createSeedV size 검증 실패: ${sizeCheck.reason}`)
  }

  // 다음 version_number 산정
  const { data: lastVersion, error: lvErr } = await supabaseAdmin
    .from('data_versions')
    .select('version_number')
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle<{ version_number: number }>()
  if (lvErr) {
    throw new Error(`Failed to read last version: ${lvErr.message}`)
  }
  const versionNumber = (lastVersion?.version_number ?? 0) + 1

  const spec = SKU_TIER_SPECS[input.skuTier]
  const { data: created, error: cErr } = await supabaseAdmin
    .from('data_versions')
    .insert({
      version_number: versionNumber,
      cohort_period_start: input.cohortPeriodStart,
      cohort_period_end: input.cohortPeriodEnd,
      total_hours: input.totalHours,
      freshness_quartile: 1,  // 신규 = 최신
      status: 'sealed',  // 즉시 판매 가능
      sku_tier: input.skuTier,
      max_sold_count: spec.maxSoldCount,
      sold_count: 0,
      sealed_at: new Date().toISOString(),
    })
    .select('version_id, version_number')
    .single<{ version_id: string; version_number: number }>()
  if (cErr || !created) {
    throw new Error(`createSeedV insert failed: ${cErr?.message}`)
  }

  return { versionId: created.version_id, versionNumber: created.version_number }
}
