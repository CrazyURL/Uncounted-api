// ── metadata_events CRUD ───────────────────────────────────────────────
// 클라이언트 앱에서 수집한 메타데이터(U-M05~U-M18, U-P01) 저장/조회.
// 범용 JSONB 구조: schema_id로 스키마 구분, dedup_key로 중복 방지.

import { createHash } from 'crypto'
import { supabaseAdmin } from '../supabase.js'

// ── Types ──────────────────────────────────────────────────────────────

export interface MetadataEventRow {
  id: string
  schema_id: string
  pseudo_id: string
  user_id: string | null
  date_bucket: string | null
  dedup_key: string
  payload: Record<string, unknown>
  received_at: string
}

export interface MetadataEventInsert {
  schema_id: string
  pseudo_id: string
  user_id?: string | null
  date_bucket?: string | null
  dedup_key: string
  payload: Record<string, unknown>
}

// ── Dedup Key ──────────────────────────────────────────────────────────

// U-M07: 자연키 (pseudoId + dateBucket + dayOfWeek + timeBucket)
// 기타 스키마: pseudoId + dateBucket + payload hash
const NATURAL_KEY_SCHEMAS: Record<string, (r: Record<string, unknown>) => string> = {
  'U-M01-v1': (r) =>
    `U-M01-v1:${r.pseudoId}:${r.dateBucket}:${r.timeBucket}:${r.callType}:${r.durationBucket}`,
  'U-M07-v1': (r) =>
    `U-M07-v1:${r.pseudoId}:${r.dateBucket}:${r.dayOfWeek}:${r.timeBucket}`,
  'U-M08-v1': (r) =>
    `U-M08-v1:${r.pseudoId}:${r.dateBucket}:${r.timeBucket}`,
  'U-M09-v1': (r) =>
    `U-M09-v1:${r.pseudoId}:${r.dateBucket}:${r.timeBucket}:${r.eventType}`,
  'U-M10-v1': (r) =>
    `U-M10-v1:${r.pseudoId}:${r.dateBucket}:${r.timeBucket}`,
}

/** Build a dedup key from a raw metadata record */
export function buildDedupKey(record: Record<string, unknown>): string {
  const schema = record.schema as string
  const pseudoId = record.pseudoId as string

  const builder = NATURAL_KEY_SCHEMAS[schema]
  if (builder) return builder(record)

  // Fallback: hash-based dedup
  const dateBucket = (record.dateBucket ?? '') as string
  const hash = createHash('sha256')
    .update(JSON.stringify(record))
    .digest('hex')
    .slice(0, 12)

  return `${schema}:${pseudoId}:${dateBucket}:${hash}`
}

// ── Date Helpers ──────────────────────────────────────────────────────

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** Derive day-of-week from YYYY-MM-DD string. Falls back to 'unknown'. */
function dateToDayOfWeek(dateBucket: string | null): string {
  if (!dateBucket || dateBucket.length < 10) return 'unknown'
  const d = new Date(dateBucket + 'T00:00:00')
  if (isNaN(d.getTime())) return 'unknown'
  return DAY_NAMES[d.getDay()]
}

// ── Quality / Sync Helpers ─────────────────────────────────────────────

export type QualityGrade = 'good' | 'partial' | 'sparse'

/** Compute quality grade from distinct timeBucket count per device-date pair */
export function computeQualityGrade(timeBucketCount: number): QualityGrade {
  if (timeBucketCount >= 8) return 'good'
  if (timeBucketCount >= 4) return 'partial'
  return 'sparse'
}

export type SyncStatus = 'upToDate' | 'stale'

/** Compute sync status: upToDate if received_at within 48h, else stale */
export function computeSyncStatus(receivedAt: string | Date): SyncStatus {
  const receivedTime = typeof receivedAt === 'string' ? new Date(receivedAt) : receivedAt
  const diffMs = Date.now() - receivedTime.getTime()
  const hours48 = 48 * 60 * 60 * 1000
  return diffMs <= hours48 ? 'upToDate' : 'stale'
}

// ── Inventory ─────────────────────────────────────────────────────────

export interface InventorySku {
  schemaId: string
  displayName: string
  totalEvents: number
  deviceCount: number
  periodStart: string | null
  periodEnd: string | null
  qualityDistribution: { good: number; partial: number; sparse: number }
  syncStatus: { upToDate: number; stale: number }
}

/** Get metadata inventory grouped by schema_id */
export async function getMetadataInventory(): Promise<{ skus: InventorySku[] }> {
  // Fetch all events with minimal fields for aggregation
  const { data, error } = await supabaseAdmin
    .from('metadata_events')
    .select('schema_id, pseudo_id, date_bucket, payload, received_at')
    .order('schema_id', { ascending: true })

  if (error) throw new Error(`getMetadataInventory failed: ${error.message}`)

  const rows = (data ?? []) as Array<{
    schema_id: string
    pseudo_id: string
    date_bucket: string | null
    payload: Record<string, unknown>
    received_at: string
  }>

  // Group by schema_id
  const schemaMap = new Map<string, typeof rows>()
  for (const row of rows) {
    const existing = schemaMap.get(row.schema_id)
    if (existing) {
      existing.push(row)
    } else {
      schemaMap.set(row.schema_id, [row])
    }
  }

  const skus: InventorySku[] = []

  for (const [schemaId, schemaRows] of schemaMap) {
    const pseudoIds = new Set<string>()
    const dates: string[] = []
    // Track timeBuckets per device-date pair for quality
    const deviceDateBuckets = new Map<string, Set<string>>()
    // Track latest received_at per pseudo_id for sync
    const deviceLatestSync = new Map<string, string>()

    for (const row of schemaRows) {
      pseudoIds.add(row.pseudo_id)
      if (row.date_bucket) dates.push(row.date_bucket)

      // Quality: count distinct timeBuckets per (pseudo_id, date_bucket)
      const timeBucket = (row.payload?.timeBucket ?? '') as string
      if (row.date_bucket && timeBucket) {
        const key = `${row.pseudo_id}:${row.date_bucket}`
        const bucketSet = deviceDateBuckets.get(key)
        if (bucketSet) {
          bucketSet.add(timeBucket)
        } else {
          deviceDateBuckets.set(key, new Set([timeBucket]))
        }
      }

      // Sync: track latest received_at per device
      const current = deviceLatestSync.get(row.pseudo_id)
      if (!current || row.received_at > current) {
        deviceLatestSync.set(row.pseudo_id, row.received_at)
      }
    }

    // Quality distribution
    const qualityDistribution = { good: 0, partial: 0, sparse: 0 }
    for (const [, bucketSet] of deviceDateBuckets) {
      const grade = computeQualityGrade(bucketSet.size)
      qualityDistribution[grade] += 1
    }

    // Sync status distribution
    const syncStatusDist = { upToDate: 0, stale: 0 }
    for (const [, latestAt] of deviceLatestSync) {
      const status = computeSyncStatus(latestAt)
      syncStatusDist[status] += 1
    }

    const sortedDates = dates.sort()

    skus.push({
      schemaId,
      displayName: schemaId,
      totalEvents: schemaRows.length,
      deviceCount: pseudoIds.size,
      periodStart: sortedDates[0] ?? null,
      periodEnd: sortedDates[sortedDates.length - 1] ?? null,
      qualityDistribution,
      syncStatus: syncStatusDist,
    })
  }

  return { skus }
}

// ── SKU Stats ─────────────────────────────────────────────────────────

export interface SkuDevice {
  pseudoId: string
  eventCount: number
  lastSyncAt: string
  syncStatus: SyncStatus
}

export interface SkuStats {
  devices: SkuDevice[]
  fieldDistributions: Record<string, Record<string, number>>
  heatmap: Array<{ dateBucket: string; timeBucket: string; count: number }>
}

/** Get detailed stats for a specific schema (SKU) */
export async function getMetadataSkuStats(schemaId: string): Promise<SkuStats> {
  const { data, error } = await supabaseAdmin
    .from('metadata_events')
    .select('pseudo_id, date_bucket, payload, received_at')
    .eq('schema_id', schemaId)

  if (error) throw new Error(`getMetadataSkuStats failed: ${error.message}`)

  const rows = (data ?? []) as Array<{
    pseudo_id: string
    date_bucket: string | null
    payload: Record<string, unknown>
    received_at: string
  }>

  // Devices aggregation
  const deviceMap = new Map<string, { count: number; lastSyncAt: string }>()
  for (const row of rows) {
    const existing = deviceMap.get(row.pseudo_id)
    if (existing) {
      existing.count += 1
      if (row.received_at > existing.lastSyncAt) {
        existing.lastSyncAt = row.received_at
      }
    } else {
      deviceMap.set(row.pseudo_id, { count: 1, lastSyncAt: row.received_at })
    }
  }

  const devices: SkuDevice[] = Array.from(deviceMap.entries()).map(
    ([pseudoId, info]) => ({
      pseudoId,
      eventCount: info.count,
      lastSyncAt: info.lastSyncAt,
      syncStatus: computeSyncStatus(info.lastSyncAt),
    }),
  )

  // Field distributions — aggregate JSONB keys from payload
  // For U-M01: callType, durationBucket, timeBucket
  const distributionKeys = getDistributionKeys(schemaId)
  const fieldDistributions: Record<string, Record<string, number>> = {}
  for (const key of distributionKeys) {
    fieldDistributions[key] = {}
  }

  // Heatmap: U-M01 uses (month, timeBucket), others use (dayOfWeek, timeBucket)
  const isMonthlyHeatmap = schemaId === 'U-M01-v1'
  const heatmapMap = new Map<string, number>()

  for (const row of rows) {
    const payload = row.payload ?? {}

    // Field distributions
    for (const key of distributionKeys) {
      const value = String(payload[key] ?? 'unknown')
      const dist = fieldDistributions[key]
      dist[value] = (dist[value] ?? 0) + 1
    }

    // Heatmap
    const timeBucket = String(payload.timeBucket ?? 'unknown')
    let rowKey: string
    if (isMonthlyHeatmap) {
      rowKey = row.date_bucket ?? 'unknown'
    } else {
      // Derive dayOfWeek: use payload.dayOfWeek if available (U-M07), else derive from date
      const payloadDow = payload.dayOfWeek as string | undefined
      rowKey = payloadDow ?? dateToDayOfWeek(row.date_bucket)
    }
    const heatKey = `${rowKey}|${timeBucket}`
    heatmapMap.set(heatKey, (heatmapMap.get(heatKey) ?? 0) + 1)
  }

  const heatmap = Array.from(heatmapMap.entries()).map(([key, count]) => {
    const [dateBucket, timeBucket] = key.split('|')
    return { dateBucket, timeBucket, count }
  })

  return { devices, fieldDistributions, heatmap }
}

/** Get payload keys to aggregate for field distributions by schema */
function getDistributionKeys(schemaId: string): string[] {
  const schemaDistKeys: Record<string, string[]> = {
    'U-M01-v1': ['callType', 'durationBucket', 'timeBucket'],
    'U-M07-v1': ['dayOfWeek', 'timeBucket'],
    'U-M08-v1': ['timeBucket'],
    'U-M09-v1': ['eventType', 'timeBucket'],
    'U-M10-v1': ['timeBucket'],
  }
  return schemaDistKeys[schemaId] ?? ['timeBucket']
}

// ── Preview ───────────────────────────────────────────────────────────

export interface PreviewFilters {
  quality?: QualityGrade
  dateFrom?: string
  dateTo?: string
  pseudoId?: string
  limit?: number
  offset?: number
}

export interface PreviewResult {
  events: MetadataEventRow[]
  fieldDistributions: Record<string, Record<string, number>>
  total: number
}

/** Get metadata events preview with filters */
export async function getMetadataPreview(
  schemaId: string,
  filters: PreviewFilters,
): Promise<PreviewResult> {
  const limit = Math.min(filters.limit ?? 50, 500)
  const offset = filters.offset ?? 0

  let query = supabaseAdmin
    .from('metadata_events')
    .select('*', { count: 'exact' })
    .eq('schema_id', schemaId)

  if (filters.pseudoId) {
    query = query.eq('pseudo_id', filters.pseudoId)
  }
  if (filters.dateFrom) {
    query = query.gte('date_bucket', filters.dateFrom)
  }
  if (filters.dateTo) {
    query = query.lte('date_bucket', filters.dateTo)
  }

  const { data, count, error } = await query
    .order('received_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw new Error(`getMetadataPreview failed: ${error.message}`)

  let events = (data ?? []) as MetadataEventRow[]
  const total = count ?? 0

  // Quality filter — applied in-memory after fetch since it depends on
  // aggregating timeBucket counts per device-date pair across the result set
  if (filters.quality) {
    const deviceDateBuckets = new Map<string, Set<string>>()
    for (const evt of events) {
      const timeBucket = String(evt.payload?.timeBucket ?? '')
      if (evt.date_bucket && timeBucket) {
        const key = `${evt.pseudo_id}:${evt.date_bucket}`
        const s = deviceDateBuckets.get(key)
        if (s) {
          s.add(timeBucket)
        } else {
          deviceDateBuckets.set(key, new Set([timeBucket]))
        }
      }
    }
    events = events.filter((evt) => {
      const key = `${evt.pseudo_id}:${evt.date_bucket}`
      const bucketSet = deviceDateBuckets.get(key)
      const grade = computeQualityGrade(bucketSet?.size ?? 0)
      return grade === filters.quality
    })
  }

  // Field distributions from the result set
  const distributionKeys = getDistributionKeys(schemaId)
  const fieldDistributions: Record<string, Record<string, number>> = {}
  for (const key of distributionKeys) {
    fieldDistributions[key] = {}
  }
  for (const evt of events) {
    const payload = evt.payload ?? {}
    for (const key of distributionKeys) {
      const value = String(payload[key] ?? 'unknown')
      const dist = fieldDistributions[key]
      dist[value] = (dist[value] ?? 0) + 1
    }
  }

  return { events, fieldDistributions, total }
}

// ── Upsert ─────────────────────────────────────────────────────────────

/** Upsert metadata events (idempotent via dedup_key) */
export async function upsertMetadataEvents(
  rows: MetadataEventInsert[],
): Promise<{ inserted: number; duplicates: number }> {
  if (rows.length === 0) return { inserted: 0, duplicates: 0 }

  const now = new Date().toISOString()
  const withTimestamp = rows.map((r) => ({ ...r, received_at: now }))

  const { data, error } = await supabaseAdmin
    .from('metadata_events')
    .upsert(withTimestamp, { onConflict: 'dedup_key', ignoreDuplicates: true })
    .select('id')

  if (error) {
    throw new Error(`upsertMetadataEvents failed: ${error.message}`)
  }

  const inserted = data?.length ?? 0
  return { inserted, duplicates: rows.length - inserted }
}

// ── Query ──────────────────────────────────────────────────────────────

/** Get per-schema event counts (RPC로 서버 사이드 집계) */
export async function getMetadataStats(): Promise<{
  totalCount: number
  bySchema: Record<string, number>
}> {
  // 스키마별로 개별 카운트 쿼리 (전체 행 로드 방지)
  const schemas = [
    'U-M01-v1',
    'U-M05-v1', 'U-M06-v1', 'U-M07-v1', 'U-M08-v1', 'U-M09-v1',
    'U-M10-v1', 'U-M11-v1', 'U-M13-v1', 'U-M14-v1', 'U-M16-v1',
    'U-M18-v1', 'U-P01-v1',
  ]

  const bySchema: Record<string, number> = {}
  let totalCount = 0

  for (const schema of schemas) {
    const { count, error } = await supabaseAdmin
      .from('metadata_events')
      .select('id', { count: 'exact', head: true })
      .eq('schema_id', schema)

    if (error) throw new Error(`getMetadataStats failed: ${error.message}`)
    const c = count ?? 0
    if (c > 0) {
      bySchema[schema] = c
      totalCount += c
    }
  }

  return { totalCount, bySchema }
}

/** Get metadata events for export — filter by pseudo_ids and optional schema */
export async function getMetadataForExport(
  pseudoIds: string[],
  schemaIds?: string[],
): Promise<MetadataEventRow[]> {
  if (pseudoIds.length === 0) return []

  let query = supabaseAdmin
    .from('metadata_events')
    .select('*')
    .in('pseudo_id', pseudoIds)

  if (schemaIds && schemaIds.length > 0) {
    query = query.in('schema_id', schemaIds)
  }

  const { data, error } = await query.order('received_at', { ascending: true })

  if (error) throw new Error(`getMetadataForExport failed: ${error.message}`)
  return (data ?? []) as MetadataEventRow[]
}

/** Get metadata summary for admin dashboard */
export async function getMetadataSummary(): Promise<{
  totalEvents: number
  uniqueUsers: number
  bySchema: Array<{ schemaId: string; count: number }>
}> {
  const schemas = [
    'U-M01-v1',
    'U-M05-v1', 'U-M06-v1', 'U-M07-v1', 'U-M08-v1', 'U-M09-v1',
    'U-M10-v1', 'U-M11-v1', 'U-M13-v1', 'U-M14-v1', 'U-M16-v1',
    'U-M18-v1', 'U-P01-v1',
  ]

  const bySchema: Array<{ schemaId: string; count: number }> = []
  let totalEvents = 0

  for (const schema of schemas) {
    const { count, error } = await supabaseAdmin
      .from('metadata_events')
      .select('id', { count: 'exact', head: true })
      .eq('schema_id', schema)

    if (error) throw new Error(`getMetadataSummary failed: ${error.message}`)
    const c = count ?? 0
    if (c > 0) {
      bySchema.push({ schemaId: schema, count: c })
      totalEvents += c
    }
  }

  // unique users — DISTINCT pseudo_id를 제한적으로 조회 (전체 행 로드 방지)
  const { data: pseudoData, error: pseudoError } = await supabaseAdmin
    .from('metadata_events')
    .select('pseudo_id')
    .limit(10000)

  if (pseudoError) throw new Error(`getMetadataSummary failed: ${pseudoError.message}`)

  const uniqueUsers = new Set((pseudoData ?? []).map((r) => (r as Record<string, unknown>).pseudo_id as string)).size

  return { totalEvents, uniqueUsers, bySchema }
}

/** Get metadata events with pagination (admin) */
export async function getMetadataEvents(opts: {
  schemaId?: string
  pseudoId?: string
  limit?: number
  offset?: number
}): Promise<{ data: MetadataEventRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 100, 500)
  const offset = opts.offset ?? 0

  let query = supabaseAdmin
    .from('metadata_events')
    .select('*', { count: 'exact' })

  if (opts.schemaId) query = query.eq('schema_id', opts.schemaId)
  if (opts.pseudoId) query = query.eq('pseudo_id', opts.pseudoId)

  const { data, count, error } = await query
    .order('received_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw new Error(`getMetadataEvents failed: ${error.message}`)
  return { data: (data ?? []) as MetadataEventRow[], total: count ?? 0 }
}
