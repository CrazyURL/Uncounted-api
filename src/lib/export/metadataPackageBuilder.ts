// ── Metadata Package Builder ──────────────────────────────────────────
// 메타데이터 전용 ZIP 패키지 생성 → S3 업로드.
// 기존 오디오용 packageBuilder.ts와 분리된 독립 모듈.
//
// 단일 SKU 구조:
//   {schemaId}_{date}_{client}/
//     manifest.json
//     data/{schemaId}.jsonl
//     data/device_summary.json
//
// 번들 구조:
//   U-M_BUNDLE_{date}_{client}/
//     {schemaId}/manifest.json
//     {schemaId}/data/{schemaId}.jsonl
//     {schemaId}/data/device_summary.json

import archiver from 'archiver'
import { PassThrough } from 'stream'
import { supabaseAdmin } from '../supabase.js'
import { S3_META_BUCKET, uploadObject } from '../s3.js'
import {
  type MetadataEventRow,
  type QualityGrade,
  computeQualityGrade,
  computeSyncStatus,
} from './metadataRepository.js'

// ── Types ──────────────────────────────────────────────────────────────

export interface MetadataManifest {
  sku: string
  version: string
  exportDate: string
  client: string
  totalEvents: number
  deviceCount: number
  period: { start: string | null; end: string | null }
  qualityDistribution: { good: number; partial: number; sparse: number }
  license: string
}

export interface DeviceSummaryEntry {
  pseudoId: string
  eventCount: number
  periodStart: string | null
  periodEnd: string | null
  qualityGrade: QualityGrade
  syncStatus: 'upToDate' | 'stale'
  lastSyncAt: string
}

export interface MetadataPackageResult {
  storagePath: string
  sizeBytes: number
  totalEvents: number
  schemaIds: string[]
}

export interface MetadataPackageOptions {
  schemaIds: string[]
  clientName: string
  filters?: {
    pseudoIds?: string[]
    dateFrom?: string
    dateTo?: string
    quality?: QualityGrade
    excludeQuality?: QualityGrade
    excludeStaleDevices?: boolean
  }
}

// ── SKU Display Mapping ──────────────────────────────────────────

/** Strip version suffix: 'U-M07-v1' → 'U-M07' */
function stripVersion(schemaId: string): string {
  return schemaId.replace(/-v\d+$/, '')
}

/** Map schemaId to human-readable JSONL filename (기획서 섹션 6) */
const SKU_JSONL_NAMES: Record<string, string> = {
  'U-M01': 'call_metadata',
  'U-M02': 'app_category_sequence',
  'U-M05': 'device_context',
  'U-M06': 'audio_environment',
  'U-M07': 'call_time_patterns',
  'U-M08': 'screen_session',
  'U-M09': 'battery_charging',
  'U-M10': 'network_transition',
  'U-M11': 'activity_state',
  'U-M13': 'ambient_light',
  'U-M14': 'device_motion',
  'U-M16': 'app_lifecycle',
  'U-M18': 'media_playback',
  'U-P01': 'photo_pattern',
}

function getJsonlFilename(schemaId: string): string {
  const skuCode = stripVersion(schemaId)
  return SKU_JSONL_NAMES[skuCode] ?? skuCode.toLowerCase().replace(/-/g, '_')
}

// ── SKU Extra Files ─────────────────────────────────────────────

/** Build SKU-specific additional files (e.g., day_of_week_distribution for U-M07) */
function buildExtraFiles(
  schemaId: string,
  events: MetadataEventRow[],
): Array<{ name: string; content: string }> {
  const skuCode = stripVersion(schemaId)

  if (skuCode === 'U-M07') {
    return [buildDayOfWeekDistribution(events)]
  }

  return []
}

function buildDayOfWeekDistribution(
  events: MetadataEventRow[],
): { name: string; content: string } {
  const dist: Record<string, number> = {}
  for (const evt of events) {
    const dow = String(evt.payload?.dayOfWeek ?? 'unknown')
    dist[dow] = (dist[dow] ?? 0) + 1
  }
  return {
    name: 'day_of_week_distribution.json',
    content: JSON.stringify({ dayOfWeekDistribution: dist }, null, 2),
  }
}

// ── Main Builder ──────────────────────────────────────────────────────

/**
 * Build a metadata ZIP package for given schema IDs and upload to S3.
 * Returns storage path and summary.
 */
export async function buildMetadataPackage(
  jobId: string,
  options: MetadataPackageOptions,
): Promise<MetadataPackageResult> {
  const { schemaIds, clientName, filters } = options
  if (schemaIds.length === 0) {
    throw new Error('At least one schemaId is required')
  }

  // Fetch events for all requested schemas
  const eventsBySchema = await fetchEventsBySchema(schemaIds, filters)

  const today = new Date().toISOString().slice(0, 10)
  const sanitizedClient = clientName.replace(/[^a-zA-Z0-9가-힣_-]/g, '_')

  const isBundle = schemaIds.length > 1
  const rootDir = isBundle
    ? `U-M_BUNDLE_${today}_${sanitizedClient}`
    : `${stripVersion(schemaIds[0])}_${today}_${sanitizedClient}`

  // Build ZIP
  const zipBuffer = await createMetadataZip(rootDir, eventsBySchema, clientName, today, isBundle)

  // Upload to S3
  const storagePath = `exports/metadata/${jobId}/package.zip`
  await uploadObject(S3_META_BUCKET, storagePath, zipBuffer, 'application/zip')

  // Count total events
  let totalEvents = 0
  for (const events of eventsBySchema.values()) {
    totalEvents += events.length
  }

  return {
    storagePath,
    sizeBytes: zipBuffer.length,
    totalEvents,
    schemaIds,
  }
}

// ── Event Fetching ────────────────────────────────────────────────────

const FETCH_PAGE_SIZE = 1000

async function fetchEventsBySchema(
  schemaIds: string[],
  filters?: MetadataPackageOptions['filters'],
): Promise<Map<string, MetadataEventRow[]>> {
  const result = new Map<string, MetadataEventRow[]>()

  for (const schemaId of schemaIds) {
    const allEvents: MetadataEventRow[] = []
    let offset = 0

    // Paginate in batches of FETCH_PAGE_SIZE to bypass Supabase/PostgREST max_rows limit
    while (true) {
      let query = supabaseAdmin
        .from('metadata_events')
        .select('*')
        .eq('schema_id', schemaId)

      if (filters?.pseudoIds && filters.pseudoIds.length > 0) {
        query = query.in('pseudo_id', filters.pseudoIds)
      }
      if (filters?.dateFrom) {
        query = query.gte('date_bucket', filters.dateFrom)
      }
      if (filters?.dateTo) {
        query = query.lte('date_bucket', filters.dateTo)
      }

      const { data, error } = await query
        .order('received_at', { ascending: true })
        .range(offset, offset + FETCH_PAGE_SIZE - 1)

      if (error) throw new Error(`fetchEventsBySchema(${schemaId}) failed: ${error.message}`)

      const page = (data ?? []) as MetadataEventRow[]
      allEvents.push(...page)

      if (page.length < FETCH_PAGE_SIZE) break // last page reached
      offset += FETCH_PAGE_SIZE
    }

    let events = allEvents

    // Quality filter: include only specific grade
    if (filters?.quality) {
      events = applyQualityFilter(events, filters.quality, 'include')
    }
    // Exclude quality: remove specific grade (e.g., sparse)
    if (filters?.excludeQuality) {
      events = applyQualityFilter(events, filters.excludeQuality, 'exclude')
    }
    // Exclude stale devices: remove events from devices with last sync > 48h
    if (filters?.excludeStaleDevices) {
      events = excludeStaleDeviceEvents(events)
    }

    result.set(schemaId, events)
  }

  return result
}

function applyQualityFilter(
  events: MetadataEventRow[],
  targetGrade: QualityGrade,
  mode: 'include' | 'exclude' = 'include',
): MetadataEventRow[] {
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

  return events.filter((evt) => {
    const key = `${evt.pseudo_id}:${evt.date_bucket}`
    const bucketSet = deviceDateBuckets.get(key)
    const grade = computeQualityGrade(bucketSet?.size ?? 0)
    return mode === 'include' ? grade === targetGrade : grade !== targetGrade
  })
}

/** Remove events from devices whose latest received_at is stale (>48h) */
function excludeStaleDeviceEvents(events: MetadataEventRow[]): MetadataEventRow[] {
  const deviceLastSync = new Map<string, string>()
  for (const evt of events) {
    const current = deviceLastSync.get(evt.pseudo_id)
    if (!current || evt.received_at > current) {
      deviceLastSync.set(evt.pseudo_id, evt.received_at)
    }
  }

  const staleDevices = new Set<string>()
  for (const [pseudoId, lastSync] of deviceLastSync) {
    if (computeSyncStatus(lastSync) === 'stale') {
      staleDevices.add(pseudoId)
    }
  }

  return events.filter((evt) => !staleDevices.has(evt.pseudo_id))
}

// ── ZIP Creation ──────────────────────────────────────────────────────

async function createMetadataZip(
  rootDir: string,
  eventsBySchema: Map<string, MetadataEventRow[]>,
  clientName: string,
  exportDate: string,
  isBundle: boolean,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } })
    const chunks: Buffer[] = []
    const passthrough = new PassThrough()

    passthrough.on('data', (chunk: Buffer) => chunks.push(chunk))
    passthrough.on('end', () => resolve(Buffer.concat(chunks)))
    passthrough.on('error', reject)

    archive.on('error', reject)
    archive.pipe(passthrough)

    for (const [schemaId, events] of eventsBySchema) {
      const skuCode = stripVersion(schemaId)
      const skuDir = isBundle ? `${rootDir}/${skuCode}` : rootDir

      // Build per-device stats
      const { manifest, deviceSummary } = buildSkuArtifacts(
        schemaId,
        events,
        clientName,
        exportDate,
      )

      // manifest.json
      archive.append(
        JSON.stringify(manifest, null, 2),
        { name: `${skuDir}/manifest.json` },
      )

      // data/{sku_name}.jsonl — human-readable filename per spec
      const jsonlName = getJsonlFilename(schemaId)
      const jsonlContent = events
        .map((evt) => JSON.stringify(evt.payload))
        .join('\n')
      archive.append(
        jsonlContent || '',
        { name: `${skuDir}/data/${jsonlName}.jsonl` },
      )

      // data/device_summary.json
      archive.append(
        JSON.stringify(deviceSummary, null, 2),
        { name: `${skuDir}/data/device_summary.json` },
      )

      // SKU-specific extra files (e.g., day_of_week_distribution.json for U-M07)
      for (const extra of buildExtraFiles(schemaId, events)) {
        archive.append(extra.content, { name: `${skuDir}/data/${extra.name}` })
      }
    }

    archive.finalize().catch(reject)
  })
}

// ── Artifact Builders ─────────────────────────────────────────────────

function buildSkuArtifacts(
  schemaId: string,
  events: MetadataEventRow[],
  clientName: string,
  exportDate: string,
): {
  manifest: MetadataManifest
  deviceSummary: DeviceSummaryEntry[]
} {
  const pseudoIds = new Set<string>()
  const dates: string[] = []
  const deviceDateBuckets = new Map<string, Set<string>>()
  const deviceInfo = new Map<string, {
    eventCount: number
    dates: string[]
    lastSyncAt: string
    timeBucketCount: number
  }>()

  for (const evt of events) {
    pseudoIds.add(evt.pseudo_id)
    if (evt.date_bucket) dates.push(evt.date_bucket)

    const timeBucket = String(evt.payload?.timeBucket ?? '')

    // Quality: device-date timeBucket coverage
    if (evt.date_bucket && timeBucket) {
      const key = `${evt.pseudo_id}:${evt.date_bucket}`
      const s = deviceDateBuckets.get(key)
      if (s) {
        s.add(timeBucket)
      } else {
        deviceDateBuckets.set(key, new Set([timeBucket]))
      }
    }

    // Per-device info
    const existing = deviceInfo.get(evt.pseudo_id)
    if (existing) {
      existing.eventCount += 1
      if (evt.date_bucket) existing.dates.push(evt.date_bucket)
      if (evt.received_at > existing.lastSyncAt) {
        existing.lastSyncAt = evt.received_at
      }
    } else {
      deviceInfo.set(evt.pseudo_id, {
        eventCount: 1,
        dates: evt.date_bucket ? [evt.date_bucket] : [],
        lastSyncAt: evt.received_at,
        timeBucketCount: 0,
      })
    }
  }

  // Compute per-device total timeBucket count (sum across all date pairs)
  for (const [key, bucketSet] of deviceDateBuckets) {
    const pseudoId = key.split(':')[0]
    const info = deviceInfo.get(pseudoId)
    if (info) {
      info.timeBucketCount += bucketSet.size
    }
  }

  // Quality distribution (global, across all device-date pairs)
  const qualityDistribution = { good: 0, partial: 0, sparse: 0 }
  for (const [, bucketSet] of deviceDateBuckets) {
    qualityDistribution[computeQualityGrade(bucketSet.size)] += 1
  }

  const sortedDates = dates.sort()

  const manifest: MetadataManifest = {
    sku: schemaId,
    version: '1.0',
    exportDate,
    client: clientName,
    totalEvents: events.length,
    deviceCount: pseudoIds.size,
    period: {
      start: sortedDates[0] ?? null,
      end: sortedDates[sortedDates.length - 1] ?? null,
    },
    qualityDistribution,
    license: 'Uncounted Data License v1',
  }

  // Device summary
  const deviceSummary: DeviceSummaryEntry[] = Array.from(deviceInfo.entries()).map(
    ([pseudoId, info]) => {
      const deviceDates = info.dates.sort()
      // Average timeBucket count per date pair for quality grade
      const dateCount = new Set(info.dates).size
      const avgTimeBuckets = dateCount > 0 ? Math.round(info.timeBucketCount / dateCount) : 0

      return {
        pseudoId,
        eventCount: info.eventCount,
        periodStart: deviceDates[0] ?? null,
        periodEnd: deviceDates[deviceDates.length - 1] ?? null,
        qualityGrade: computeQualityGrade(avgTimeBuckets),
        syncStatus: computeSyncStatus(info.lastSyncAt),
        lastSyncAt: info.lastSyncAt,
      }
    },
  )

  return { manifest, deviceSummary }
}
