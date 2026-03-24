// S3 호환 버킷에 CORS 설정 적용
// 실행: npx tsx scripts/set-cors.ts <dev|live>

import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3'
import { config } from 'dotenv'

const env = process.argv[2] as 'dev' | 'live' | undefined

if (!env || !['dev', 'live'].includes(env)) {
  console.error('Usage: npx tsx scripts/set-cors.ts <dev|live>')
  process.exit(1)
}

// 환경별 .env 파일 로드
const envFile = env === 'live' ? '.env.production' : '.env'
config({ path: envFile })
console.log(`환경: ${env} (${envFile})`)

const ORIGINS_BY_ENV = {
  dev: [
    'http://localhost:5173',
    'http://localhost:15173',
    'https://uncounted-admin-dev.onrender.com',
  ],
  live: [
    'https://uncounted-admin-prod.onrender.com',
  ],
} as const

const endpoint = process.env.S3_ENDPOINT
const region = process.env.S3_REGION ?? 'kr-standard'
const accessKeyId = process.env.S3_ACCESS_KEY
const secretAccessKey = process.env.S3_SECRET_KEY

if (!endpoint || !accessKeyId || !secretAccessKey) {
  console.error('Missing S3 env vars (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY)')
  process.exit(1)
}

const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
})

const AUDIO_BUCKET = process.env.S3_AUDIO_BUCKET ?? 'sanitized-audio'
const META_BUCKET = process.env.S3_META_BUCKET ?? 'meta-jsonl'

const corsConfig = {
  CORSRules: [
    {
      AllowedOrigins: [...ORIGINS_BY_ENV[env]],
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      MaxAgeSeconds: 3600,
    },
  ],
}

async function setCors(bucket: string) {
  try {
    await s3.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: corsConfig }))
    console.log(`[OK] ${bucket}: CORS 설정 완료`)

    const result = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }))
    console.log(`     Rules:`, JSON.stringify(result.CORSRules, null, 2))
  } catch (err: any) {
    console.error(`[FAIL] ${bucket}: ${err.message}`)
  }
}

async function main() {
  console.log(`Endpoint: ${endpoint}`)
  console.log(`Audio bucket: ${AUDIO_BUCKET}`)
  console.log(`Meta bucket: ${META_BUCKET}`)
  console.log(`Origins: ${ORIGINS_BY_ENV[env].join(', ')}`)
  console.log('')

  await setCors(AUDIO_BUCKET)
  await setCors(META_BUCKET)
}

main()
