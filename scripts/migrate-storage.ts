// ── Supabase Storage → iwinv S3 마이그레이션 스크립트 ──────────────────
// 사용법: npx tsx scripts/migrate-storage.ts [--dry-run]
//
// 필수 환경변수:
//   SUPABASE_S3_ENDPOINT, SUPABASE_S3_ACCESS_KEY, SUPABASE_S3_SECRET_KEY
//   S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_AUDIO_BUCKET, S3_META_BUCKET

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'

// ── 환경변수 로드 ──────────────────────────────────────────────────────
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'
const { config } = await import('dotenv')
config({ path: envFile })

// ── CLI 옵션 ───────────────────────────────────────────────────────────
const isDryRun = process.argv.includes('--dry-run')

// ── Source: Supabase S3 호환 클라이언트 ────────────────────────────────
const supabaseEndpoint = process.env.SUPABASE_S3_ENDPOINT
const supabaseAccessKey = process.env.SUPABASE_S3_ACCESS_KEY
const supabaseSecretKey = process.env.SUPABASE_S3_SECRET_KEY

if (!supabaseEndpoint || !supabaseAccessKey || !supabaseSecretKey) {
  throw new Error(
    'Missing Supabase S3 env vars:\n' +
    '- SUPABASE_S3_ENDPOINT\n' +
    '- SUPABASE_S3_ACCESS_KEY\n' +
    '- SUPABASE_S3_SECRET_KEY',
  )
}

const supabaseS3 = new S3Client({
  endpoint: supabaseEndpoint,
  region: process.env.SUPABASE_S3_REGION ?? 'ap-northeast-2',
  credentials: {
    accessKeyId: supabaseAccessKey,
    secretAccessKey: supabaseSecretKey,
  },
  forcePathStyle: true,
})

// ── Destination: iwinv S3 클라이언트 ──────────────────────────────────
const iwinvEndpoint = process.env.S3_ENDPOINT
const iwinvAccessKey = process.env.S3_ACCESS_KEY
const iwinvSecretKey = process.env.S3_SECRET_KEY

if (!iwinvEndpoint || !iwinvAccessKey || !iwinvSecretKey) {
  throw new Error(
    'Missing iwinv S3 env vars:\n' +
    '- S3_ENDPOINT\n' +
    '- S3_ACCESS_KEY\n' +
    '- S3_SECRET_KEY',
  )
}

const iwinvS3 = new S3Client({
  endpoint: iwinvEndpoint,
  region: process.env.S3_REGION ?? 'kr-standard',
  credentials: {
    accessKeyId: iwinvAccessKey,
    secretAccessKey: iwinvSecretKey,
  },
  forcePathStyle: true,
})

const AUDIO_BUCKET = process.env.S3_AUDIO_BUCKET ?? 'sanitized-audio'
const META_BUCKET = process.env.S3_META_BUCKET ?? 'meta-jsonl'

// ── 유틸리티 ───────────────────────────────────────────────────────────

interface S3Object {
  key: string
  size: number
}

async function listAllObjects(
  client: S3Client,
  bucket: string,
): Promise<S3Object[]> {
  const objects: S3Object[] = []
  let continuationToken: string | undefined

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }),
    )

    for (const obj of response.Contents ?? []) {
      if (obj.Key) {
        objects.push({ key: obj.Key, size: obj.Size ?? 0 })
      }
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined
  } while (continuationToken)

  return objects
}

async function copyObject(
  sourceClient: S3Client,
  sourceBucket: string,
  destClient: S3Client,
  destBucket: string,
  key: string,
): Promise<void> {
  // 1. Source에서 다운로드
  const getResponse = await sourceClient.send(
    new GetObjectCommand({ Bucket: sourceBucket, Key: key }),
  )

  const body = await getResponse.Body?.transformToByteArray()
  if (!body) {
    throw new Error(`Empty body for key: ${key}`)
  }

  // 2. Destination에 업로드 (키 보존)
  await destClient.send(
    new PutObjectCommand({
      Bucket: destBucket,
      Key: key,
      Body: body,
      ContentType: getResponse.ContentType ?? 'application/octet-stream',
    }),
  )
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

// ── 메인 마이그레이션 로직 ─────────────────────────────────────────────

interface MigrationResult {
  bucket: string
  total: number
  success: number
  skipped: number
  failed: Array<{ key: string; error: string }>
  totalBytes: number
}

async function migrateBucket(
  sourceBucket: string,
  destBucket: string,
): Promise<MigrationResult> {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`버킷 마이그레이션: ${sourceBucket} → ${destBucket}`)
  console.log('='.repeat(60))

  // 1. Source 객체 목록
  console.log('\n[1/3] Source 객체 목록 조회 중...')
  const sourceObjects = await listAllObjects(supabaseS3, sourceBucket)
  console.log(`  → ${sourceObjects.length}개 객체 발견 (${formatBytes(sourceObjects.reduce((s, o) => s + o.size, 0))})`)

  if (sourceObjects.length === 0) {
    console.log('  → 이관할 객체가 없습니다.')
    return { bucket: sourceBucket, total: 0, success: 0, skipped: 0, failed: [], totalBytes: 0 }
  }

  // 2. Destination 기존 객체 확인 (중복 skip)
  console.log('\n[2/3] Destination 기존 객체 확인 중...')
  const destObjects = await listAllObjects(iwinvS3, destBucket)
  const destKeys = new Set(destObjects.map((o) => o.key))
  console.log(`  → ${destObjects.length}개 기존 객체`)

  // 3. 복제
  console.log(`\n[3/3] 복제 ${isDryRun ? '(DRY RUN)' : '시작'}...`)

  const result: MigrationResult = {
    bucket: sourceBucket,
    total: sourceObjects.length,
    success: 0,
    skipped: 0,
    failed: [],
    totalBytes: 0,
  }

  for (let i = 0; i < sourceObjects.length; i++) {
    const obj = sourceObjects[i]
    const progress = `[${i + 1}/${sourceObjects.length}]`

    // 이미 존재하면 skip
    if (destKeys.has(obj.key)) {
      console.log(`  ${progress} SKIP (exists): ${obj.key}`)
      result.skipped++
      continue
    }

    if (isDryRun) {
      console.log(`  ${progress} DRY: ${obj.key} (${formatBytes(obj.size)})`)
      result.success++
      result.totalBytes += obj.size
      continue
    }

    try {
      await copyObject(supabaseS3, sourceBucket, iwinvS3, destBucket, obj.key)
      console.log(`  ${progress} OK: ${obj.key} (${formatBytes(obj.size)})`)
      result.success++
      result.totalBytes += obj.size
    } catch (err: any) {
      console.error(`  ${progress} FAIL: ${obj.key} — ${err.message}`)
      result.failed.push({ key: obj.key, error: err.message })
    }
  }

  return result
}

// ── 실행 ───────────────────────────────────────────────────────────────

async function main() {
  console.log('Supabase Storage → iwinv S3 마이그레이션')
  console.log(`모드: ${isDryRun ? 'DRY RUN (실제 복제 안 함)' : '실제 복제'}`)
  console.log(`Source: ${supabaseEndpoint}`)
  console.log(`Dest:   ${iwinvEndpoint}`)

  const results: MigrationResult[] = []

  // 오디오 버킷 (Supabase에는 sanitized-audio만 존재)
  const audioResult = await migrateBucket('sanitized-audio', AUDIO_BUCKET)
  results.push(audioResult)

  // 요약
  console.log(`\n${'='.repeat(60)}`)
  console.log('마이그레이션 요약')
  console.log('='.repeat(60))

  for (const r of results) {
    console.log(`\n  [${r.bucket}]`)
    console.log(`    전체: ${r.total}개`)
    console.log(`    성공: ${r.success}개 (${formatBytes(r.totalBytes)})`)
    console.log(`    스킵: ${r.skipped}개 (이미 존재)`)
    console.log(`    실패: ${r.failed.length}개`)

    if (r.failed.length > 0) {
      console.log('    실패 목록:')
      for (const f of r.failed) {
        console.log(`      - ${f.key}: ${f.error}`)
      }
    }
  }

  const totalFailed = results.reduce((s, r) => s + r.failed.length, 0)
  if (totalFailed > 0) {
    console.log(`\n⚠ ${totalFailed}건 실패. 재실행하면 실패 건만 재시도됩니다.`)
    process.exit(1)
  }

  console.log('\n마이그레이션 완료.')
}

main().catch((err) => {
  console.error('마이그레이션 중 오류:', err)
  process.exit(1)
})
