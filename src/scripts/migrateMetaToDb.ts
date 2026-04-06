// ── S3 메타데이터 JSONL → metadata_events DB 마이그레이션 ──────────────
// 일회성 스크립트: npx tsx src/scripts/migrateMetaToDb.ts
//
// S3_META_BUCKET에서 모든 JSONL 파일을 읽어 metadata_events 테이블에 적재.
// dedup_key 기반 중복 방지 → 재실행 안전.

import 'dotenv/config'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { s3Client, S3_META_BUCKET, listFolders, listObjects } from '../lib/s3.js'
import {
  buildDedupKey,
  upsertMetadataEvents,
  type MetadataEventInsert,
} from '../lib/export/metadataRepository.js'

const ALLOWED_SCHEMAS = new Set([
  'U-M05-v1', 'U-M06-v1', 'U-M07-v1', 'U-M08-v1', 'U-M09-v1',
  'U-M10-v1', 'U-M11-v1', 'U-M13-v1', 'U-M14-v1', 'U-M16-v1',
  'U-M18-v1', 'U-P01-v1',
])

const UPSERT_BATCH = 200

interface MigrationStats {
  files: number
  records: number
  inserted: number
  duplicates: number
  parseErrors: number
  fileErrors: number
}

async function downloadAndParse(key: string): Promise<Record<string, unknown>[]> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: S3_META_BUCKET, Key: key }),
  )

  if (!response.Body) {
    throw new Error(`Empty body for key: ${key}`)
  }

  const text = await response.Body.transformToString('utf-8')
  const lines = text.trim().split('\n').filter(Boolean)
  const records: Record<string, unknown>[] = []

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.schema === 'string' &&
        typeof parsed.pseudoId === 'string' &&
        ALLOWED_SCHEMAS.has(parsed.schema)
      ) {
        records.push(parsed)
      }
    } catch {
      // skip malformed lines
    }
  }

  return records
}

async function migrate(): Promise<void> {
  console.log('=== S3 Meta → DB Migration ===')
  console.log(`Bucket: ${S3_META_BUCKET}`)

  const stats: MigrationStats = {
    files: 0, records: 0, inserted: 0, duplicates: 0, parseErrors: 0, fileErrors: 0,
  }

  // 1. userId 폴더 목록
  const userPrefixes = await listFolders(S3_META_BUCKET, '')
  console.log(`Users found: ${userPrefixes.length}`)

  for (const prefix of userPrefixes) {
    const userId = prefix.replace(/\/$/, '')
    const files = await listObjects(S3_META_BUCKET, prefix, 10000)
    const jsonlFiles = files.filter((f) => f.key.endsWith('.jsonl'))

    console.log(`  User ${userId.slice(0, 8)}...: ${jsonlFiles.length} files`)

    for (const file of jsonlFiles) {
      stats.files++

      try {
        const records = await downloadAndParse(file.key)
        if (records.length === 0) {
          stats.parseErrors++
          continue
        }

        stats.records += records.length

        // userId를 UUID로 변환 시도 (S3 경로의 userId)
        const userUuid = userId.match(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        )
          ? userId
          : null

        const inserts: MetadataEventInsert[] = records.map((record) => ({
          schema_id: record.schema as string,
          pseudo_id: record.pseudoId as string,
          user_id: userUuid,
          date_bucket: (record.dateBucket as string | undefined) ?? null,
          dedup_key: buildDedupKey(record),
          payload: record,
        }))

        // 배치 upsert
        for (let i = 0; i < inserts.length; i += UPSERT_BATCH) {
          const batch = inserts.slice(i, i + UPSERT_BATCH)
          const result = await upsertMetadataEvents(batch)
          stats.inserted += result.inserted
          stats.duplicates += result.duplicates
        }
      } catch (err) {
        stats.fileErrors++
        const message = err instanceof Error ? err.message : String(err)
        console.error(`    ERROR ${file.key}: ${message}`)
      }
    }
  }

  console.log('\n=== Migration Complete ===')
  console.log(`  Files processed: ${stats.files}`)
  console.log(`  Records parsed:  ${stats.records}`)
  console.log(`  Inserted:        ${stats.inserted}`)
  console.log(`  Duplicates:      ${stats.duplicates}`)
  console.log(`  Parse errors:    ${stats.parseErrors}`)
  console.log(`  File errors:     ${stats.fileErrors}`)
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
