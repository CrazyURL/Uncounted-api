// ── 개발 스토리지 음성파일 다운로드 스크립트 ─────────────────────────────
// 사용법:
//   npx tsx scripts/download-dev-audio.ts                            # 전체
//   npx tsx scripts/download-dev-audio.ts --prefix "userId/session/" # prefix 직접 지정
//   npx tsx scripts/download-dev-audio.ts --user <userId>            # userId 필터
//   npx tsx scripts/download-dev-audio.ts --session <sessionId>      # sessionId 포함 파일
//   npx tsx scripts/download-dev-audio.ts --out ./my-downloads       # 출력 디렉토리 지정
//
// 우선순위: --prefix > --session > --user > 전체

import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import fs from 'node:fs'
import path from 'node:path'

// ── 환경변수 로드 ──────────────────────────────────────────────────────
const { config } = await import('dotenv')
config({ path: '.env' })

// ── CLI 파싱 ───────────────────────────────────────────────────────────
const args = process.argv.slice(2)

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] : undefined
}

const prefixArg = getArg('--prefix')
const userArg = getArg('--user')
const sessionArg = getArg('--session')
const outDir = getArg('--out') ?? './downloads'

// 우선순위: --prefix > --session > --user > 전체(빈 prefix)
const resolvedPrefix: string = (() => {
  if (prefixArg !== undefined) return prefixArg
  if (sessionArg !== undefined) return sessionArg
  if (userArg !== undefined) return `${userArg}/`
  return ''
})()

// ── S3 클라이언트 초기화 ───────────────────────────────────────────────
const endpoint = process.env.S3_ENDPOINT
const region = process.env.S3_REGION ?? 'kr-standard'
const accessKeyId = process.env.S3_ACCESS_KEY
const secretAccessKey = process.env.S3_SECRET_KEY
const bucket = process.env.S3_AUDIO_BUCKET

if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
  console.error(
    'Missing S3 environment variables:\n' +
    '  S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_AUDIO_BUCKET',
  )
  process.exit(1)
}

const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
})

// ── 오브젝트 목록 조회 (페이지네이션 포함) ────────────────────────────
async function listAllObjects(prefix: string): Promise<string[]> {
  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }),
    )

    for (const obj of response.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key)
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (continuationToken)

  return keys
}

// ── 단일 파일 다운로드 ─────────────────────────────────────────────────
async function downloadObject(key: string, destPath: string): Promise<void> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  )

  if (!(response.Body instanceof Readable)) {
    throw new Error(`Unexpected response body type for key: ${key}`)
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  const dest = fs.createWriteStream(destPath)
  await pipeline(response.Body, dest)
}

// ── 메인 ──────────────────────────────────────────────────────────────
console.log(`Bucket : ${bucket}`)
console.log(`Prefix : ${resolvedPrefix || '(전체)'}`)
console.log(`Output : ${outDir}`)
console.log('')

let keys = await listAllObjects(resolvedPrefix)

// --session 옵션은 prefix만으로 필터하면 다른 userId 폴더도 포함될 수 있으므로
// key에 sessionId 문자열이 포함된 항목만 재필터링
if (sessionArg !== undefined && prefixArg === undefined) {
  keys = keys.filter((k) => k.includes(sessionArg))
}

if (keys.length === 0) {
  console.log('다운로드할 파일이 없습니다.')
  process.exit(0)
}

console.log(`총 ${keys.length}개 파일 다운로드 시작...\n`)

let success = 0
let failed = 0

for (let i = 0; i < keys.length; i++) {
  const key = keys[i]
  const destPath = path.join(outDir, key)
  const label = `[${i + 1}/${keys.length}]`

  try {
    await downloadObject(key, destPath)
    console.log(`${label} ✓ ${key}`)
    success++
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`${label} ✗ ${key} — ${msg}`)
    failed++
  }
}

console.log('')
console.log(`완료: 성공 ${success}개 / 실패 ${failed}개`)
console.log(`저장 위치: ${path.resolve(outDir)}`)
