// ════════════════════════════════════════════════════════════════════
// iwinv S3 버킷 일괄 삭제 — BM v10 STAGE 0
// ════════════════════════════════════════════════════════════════════
//
// WHY
//   BM v10 전면 리셋 — DB 919 sessions 는 이미 wipe 완료. iwinv 의
//   sanitized-audio + meta-jsonl 버킷에 잔존하는 객체 모두 삭제.
//
// 사용 (Render Shell 권장 — 자격증명 로컬 노출 없음)
//   1. Render Dashboard → uncounted-api-dev → Shell 탭
//   2. cd /opt/render/project/src/uncounted-api  (또는 PWD 기본값)
//   3. node scripts/wipe-iwinv-buckets.mjs              # dry-run (갯수만)
//   4. node scripts/wipe-iwinv-buckets.mjs --apply      # 실제 삭제
//
// 로컬 실행 시
//   uncounted-api/.env 에 S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY 추가 후
//   node --env-file=.env scripts/wipe-iwinv-buckets.mjs --apply
//
// 안전장치
//   - dry-run 기본값 (실수로 즉시 삭제 방지)
//   - 버킷별 사전 카운트 출력 → 사용자가 규모 확인 가능
//   - 페이지당 1000개 (S3 DeleteObjects 한도) 배치 처리
//   - 실패 시 즉시 abort, 어느 키에서 막혔는지 보고
// ════════════════════════════════════════════════════════════════════

import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'

// ── env 검증 ────────────────────────────────────────────────────────
const endpoint = process.env.S3_ENDPOINT
const region = process.env.S3_REGION ?? 'kr-standard'
const accessKeyId = process.env.S3_ACCESS_KEY
const secretAccessKey = process.env.S3_SECRET_KEY
const audioBucket = process.env.S3_AUDIO_BUCKET ?? 'sanitized-audio'
const metaBucket = process.env.S3_META_BUCKET ?? 'meta-jsonl'

const missing = []
if (!endpoint) missing.push('S3_ENDPOINT')
if (!accessKeyId) missing.push('S3_ACCESS_KEY')
if (!secretAccessKey) missing.push('S3_SECRET_KEY')
if (missing.length) {
  console.error(`❌ 환경변수 누락: ${missing.join(', ')}`)
  console.error('   Render Shell 에서 실행 중이면 자동 로드되어야 함 — Environment 탭 확인')
  console.error('   로컬 실행 시: node --env-file=.env scripts/wipe-iwinv-buckets.mjs')
  process.exit(2)
}

// ── S3 client ───────────────────────────────────────────────────────
const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
  maxAttempts: 5,
})

const APPLY = process.argv.includes('--apply')

// ── 페이지네이션으로 모든 객체 키 수집 ────────────────────────────
async function listAllKeys(bucket) {
  const keys = []
  let continuationToken = undefined
  while (true) {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    )
    if (res.Contents?.length) {
      for (const obj of res.Contents) {
        if (obj.Key) keys.push(obj.Key)
      }
    }
    if (!res.IsTruncated) break
    continuationToken = res.NextContinuationToken
  }
  return keys
}

// ── 1000개씩 배치 삭제 ──────────────────────────────────────────────
async function deleteAllKeys(bucket, keys) {
  let deleted = 0
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    const res = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    )
    if (res.Errors?.length) {
      console.error(`  ❌ 배치 ${i / 1000 + 1} 일부 실패 (${res.Errors.length}건):`)
      for (const e of res.Errors.slice(0, 3)) {
        console.error(`     ${e.Key}: ${e.Code} ${e.Message}`)
      }
      throw new Error(`Bucket ${bucket}: ${res.Errors.length} object(s) failed to delete`)
    }
    deleted += batch.length
    process.stdout.write(`  ${deleted}/${keys.length} 삭제됨\r`)
  }
  process.stdout.write('\n')
  return deleted
}

// ── 메인 ────────────────────────────────────────────────────────────
async function processBucket(bucket) {
  console.log(`\n━━━ Bucket: ${bucket} ━━━`)
  let keys
  try {
    keys = await listAllKeys(bucket)
  } catch (e) {
    console.error(`  ❌ list 실패: ${e.name}: ${e.message}`)
    if (e.Code === 'NoSuchBucket') {
      console.log(`  → 버킷 없음 (skip)`)
      return { listed: 0, deleted: 0 }
    }
    throw e
  }
  console.log(`  객체 수: ${keys.length}건`)
  if (keys.length === 0) return { listed: 0, deleted: 0 }
  if (keys.length <= 5) {
    console.log(`  샘플:`)
    for (const k of keys) console.log(`    ${k}`)
  } else {
    console.log(`  샘플 (앞 3건):`)
    for (const k of keys.slice(0, 3)) console.log(`    ${k}`)
    console.log(`    ... 외 ${keys.length - 3}건`)
  }
  if (!APPLY) {
    console.log(`  (dry-run — 실제 삭제 안 함)`)
    return { listed: keys.length, deleted: 0 }
  }
  console.log(`  삭제 시작...`)
  const deleted = await deleteAllKeys(bucket, keys)
  return { listed: keys.length, deleted }
}

async function main() {
  console.log(`=== iwinv S3 버킷 ${APPLY ? '일괄 삭제' : '갯수 조회 (dry-run)'} ===`)
  console.log(`endpoint:    ${endpoint}`)
  console.log(`region:      ${region}`)
  console.log(`access key:  ${accessKeyId.slice(0, 6)}…`)
  console.log(`buckets:     ${audioBucket}, ${metaBucket}`)

  const buckets = [audioBucket, metaBucket]
  const results = []
  for (const b of buckets) {
    results.push({ bucket: b, ...(await processBucket(b)) })
  }

  console.log(`\n=== 결과 ===`)
  for (const r of results) {
    console.log(
      `  ${r.bucket.padEnd(20)} listed=${String(r.listed).padStart(6)}  deleted=${String(r.deleted).padStart(6)}`,
    )
  }

  if (!APPLY) {
    console.log(`\nDry-run 완료. 실제 삭제: node scripts/wipe-iwinv-buckets.mjs --apply`)
  } else {
    console.log(`\n사후 검증 (모두 0 기대):`)
    for (const b of buckets) {
      const remaining = await listAllKeys(b).catch(() => [])
      console.log(`  ${b.padEnd(20)} 잔존: ${remaining.length}건`)
    }
  }
}

main().catch((e) => {
  console.error('\nFATAL:', e.name, e.message)
  if (e.$metadata) {
    console.error('  http=', e.$metadata.httpStatusCode, ' reqId=', e.$metadata.requestId)
  }
  process.exit(1)
})
