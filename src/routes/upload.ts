// ── Upload Route — NDJSON 메타데이터 배치 수신 ────────────────────────
// 클라이언트 uploadQueue가 POST /api/upload으로 NDJSON 배치 전송.
// 각 줄의 schema 필드로 스키마 구분, dedup_key로 중복 방지.

import { Hono } from 'hono'
import { optionalAuthMiddleware } from '../lib/middleware.js'
import {
  upsertMetadataEvents,
  buildDedupKey,
  type MetadataEventInsert,
} from '../lib/export/metadataRepository.js'
import { uploadObject, S3_META_BUCKET } from '../lib/s3.js'

const upload = new Hono()

upload.use('/*', optionalAuthMiddleware)

// ── 보안 상수 ──────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 1_048_576      // 1 MB
const MAX_RECORDS_PER_BATCH = 200
const MAX_PAYLOAD_BYTES = 10_240      // 레코드당 10 KB

const ALLOWED_SCHEMAS = new Set([
  'U-M05-v1', 'U-M06-v1', 'U-M07-v1', 'U-M08-v1', 'U-M09-v1',
  'U-M10-v1', 'U-M11-v1', 'U-M13-v1', 'U-M14-v1', 'U-M16-v1',
  'U-M18-v1', 'U-P01-v1',
])

/**
 * POST /
 * Body: NDJSON (application/x-ndjson)
 * 각 줄: { schema: "U-M07-v1", pseudoId: "xxx", ... }
 */
upload.post('/', async (c) => {
  // Body 크기 제한 (Content-Length 기반 사전 체크)
  const contentLength = Number(c.req.header('Content-Length') ?? 0)
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: 'Payload too large' }, 413)
  }

  const userId = (c.get('userId') as string | undefined) ?? null

  const rawBody = await c.req.text()
  if (!rawBody || rawBody.trim().length === 0) {
    return c.json({ error: 'Empty body' }, 400)
  }

  // Body 크기 재확인 (Content-Length 위조 대비)
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return c.json({ error: 'Payload too large' }, 413)
  }

  const lines = rawBody.trim().split('\n')
  if (lines.length > MAX_RECORDS_PER_BATCH) {
    return c.json({ error: `Too many records (max ${MAX_RECORDS_PER_BATCH})` }, 400)
  }

  const records: Record<string, unknown>[] = []
  const parseErrors: number[] = []

  for (let i = 0; i < lines.length; i++) {
    try {
      // 레코드당 크기 제한
      if (Buffer.byteLength(lines[i], 'utf8') > MAX_PAYLOAD_BYTES) {
        parseErrors.push(i)
        continue
      }

      const parsed = JSON.parse(lines[i])
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.schema === 'string' &&
        typeof parsed.pseudoId === 'string' &&
        ALLOWED_SCHEMAS.has(parsed.schema)
      ) {
        records.push(parsed)
      } else {
        parseErrors.push(i)
      }
    } catch {
      parseErrors.push(i)
    }
  }

  if (records.length === 0) {
    return c.json({ error: 'No valid records', parseErrors }, 400)
  }

  const inserts: MetadataEventInsert[] = records.map((record) => ({
    schema_id: record.schema as string,
    pseudo_id: record.pseudoId as string,
    user_id: userId,
    date_bucket: (record.dateBucket as string | undefined) ?? null,
    dedup_key: buildDedupKey(record),
    payload: record,
  }))

  try {
    const result = await upsertMetadataEvents(inserts)

    // S3 백업 (fire-and-forget)
    const batchId = crypto.randomUUID()
    uploadObject(
      S3_META_BUCKET,
      `metadata/${userId ?? 'anon'}/${batchId}.jsonl`,
      rawBody,
      'application/x-ndjson',
    ).catch((err) => console.error('[upload] S3 backup failed:', err))

    return c.json({
      accepted: result.inserted,
      duplicates: result.duplicates,
      parseErrors: parseErrors.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[upload] DB upsert error:', message)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

export default upload
