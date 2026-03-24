// ── Supabase ↔ iwinv S3 마이그레이션 검증 스크립트 ────────────────────
// 사용법: npx tsx scripts/verify-migration.ts
//
// 양쪽 버킷의 객체 수와 크기를 비교하여 이관 완료 여부를 확인합니다.

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'

// ── 환경변수 로드 ──────────────────────────────────────────────────────
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'
const { config } = await import('dotenv')
config({ path: envFile })

// ── S3 클라이언트 생성 ─────────────────────────────────────────────────
const supabaseEndpoint = process.env.SUPABASE_S3_ENDPOINT
const supabaseAccessKey = process.env.SUPABASE_S3_ACCESS_KEY
const supabaseSecretKey = process.env.SUPABASE_S3_SECRET_KEY

if (!supabaseEndpoint || !supabaseAccessKey || !supabaseSecretKey) {
  throw new Error('Missing SUPABASE_S3_* env vars')
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

const iwinvEndpoint = process.env.S3_ENDPOINT
const iwinvAccessKey = process.env.S3_ACCESS_KEY
const iwinvSecretKey = process.env.S3_SECRET_KEY

if (!iwinvEndpoint || !iwinvAccessKey || !iwinvSecretKey) {
  throw new Error('Missing S3_* env vars')
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

// ── 검증 로직 ──────────────────────────────────────────────────────────

async function verifyBucket(
  sourceBucket: string,
  destBucket: string,
): Promise<boolean> {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`검증: ${sourceBucket} (Supabase) ↔ ${destBucket} (iwinv)`)
  console.log('='.repeat(60))

  const [sourceObjects, destObjects] = await Promise.all([
    listAllObjects(supabaseS3, sourceBucket),
    listAllObjects(iwinvS3, destBucket),
  ])

  const sourceTotal = sourceObjects.reduce((s, o) => s + o.size, 0)
  const destTotal = destObjects.reduce((s, o) => s + o.size, 0)

  console.log(`\n  Source (Supabase): ${sourceObjects.length}개, ${formatBytes(sourceTotal)}`)
  console.log(`  Dest   (iwinv):   ${destObjects.length}개, ${formatBytes(destTotal)}`)

  // key → size 매핑
  const destMap = new Map(destObjects.map((o) => [o.key, o.size]))

  const missing: string[] = []
  const sizeMismatch: Array<{ key: string; source: number; dest: number }> = []

  for (const obj of sourceObjects) {
    const destSize = destMap.get(obj.key)
    if (destSize === undefined) {
      missing.push(obj.key)
    } else if (destSize !== obj.size) {
      sizeMismatch.push({ key: obj.key, source: obj.size, dest: destSize })
    }
  }

  let passed = true

  if (missing.length > 0) {
    passed = false
    console.log(`\n  누락 파일 (${missing.length}건):`)
    for (const key of missing) {
      console.log(`    - ${key}`)
    }
  }

  if (sizeMismatch.length > 0) {
    passed = false
    console.log(`\n  크기 불일치 (${sizeMismatch.length}건):`)
    for (const m of sizeMismatch) {
      console.log(`    - ${m.key}: source=${formatBytes(m.source)}, dest=${formatBytes(m.dest)}`)
    }
  }

  if (passed) {
    console.log('\n  PASS — 모든 파일이 정상적으로 이관되었습니다.')
  } else {
    console.log('\n  FAIL — 위 항목을 확인 후 migrate-storage.ts를 재실행하세요.')
  }

  return passed
}

// ── 실행 ───────────────────────────────────────────────────────────────

async function main() {
  console.log('마이그레이션 검증 시작')

  const audioOk = await verifyBucket('sanitized-audio', AUDIO_BUCKET)
  const metaOk = await verifyBucket('meta-jsonl', META_BUCKET)

  console.log(`\n${'='.repeat(60)}`)
  if (audioOk && metaOk) {
    console.log('전체 검증 PASS')
  } else {
    console.log('전체 검증 FAIL')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('검증 중 오류:', err)
  process.exit(1)
})
