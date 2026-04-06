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
