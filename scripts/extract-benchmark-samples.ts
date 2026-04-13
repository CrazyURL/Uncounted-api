// ── Voice API 벤치마크 샘플 추출 ─────────────────────────────────────
// 용도: WhisperX large-v3-turbo 전환 벤치마크용 샘플 추출
// 조건: consent=both_agreed, 장기 버킷(600~1800초), 최신순
//
// 사용법:
//   cd uncounted-api
//   npx tsx scripts/extract-benchmark-samples.ts --out ./benchmark-samples --count 4
//
// 산출물:
//   ./benchmark-samples/long/{hash8}.m4a  (세션ID SHA-256 앞 8자리)
//   ./benchmark-samples/samples.json

import { createClient } from '@supabase/supabase-js'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const { config } = await import('dotenv')
config({ path: '.env' })

// ── CLI ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const getArg = (flag: string): string | undefined => {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] : undefined
}

const outDir = getArg('--out') ?? './benchmark-samples'
const count = parseInt(getArg('--count') ?? '4', 10)
const minDuration = 600 // 10분
const maxDuration = 1800 // 30분

// ── 환경변수 ───────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const s3Endpoint = process.env.S3_ENDPOINT
const s3Region = process.env.S3_REGION ?? 'kr-standard'
const s3AccessKey = process.env.S3_ACCESS_KEY
const s3SecretKey = process.env.S3_SECRET_KEY
const s3Bucket = process.env.S3_AUDIO_BUCKET

if (!supabaseUrl || !supabaseKey || !s3Endpoint || !s3AccessKey || !s3SecretKey || !s3Bucket) {
  console.error('Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, S3_*')
  process.exit(1)
}

// ── 클라이언트 ─────────────────────────────────────────────────────────
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
})

const s3 = new S3Client({
  endpoint: s3Endpoint,
  region: s3Region,
  credentials: { accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey },
  forcePathStyle: true,
})

// ── 세션 조회 ──────────────────────────────────────────────────────────
interface SessionRow {
  id: string
  pid: string | null
  duration: number
  audio_url: string | null
  date: string
}

console.log(`Supabase: ${supabaseUrl}`)
console.log(`버킷: long (${minDuration}~${maxDuration}s), 개수: ${count}, 출력: ${outDir}\n`)

const { data, error } = await supabase
  .from('sessions')
  .select('id, pid, duration, audio_url, date')
  .eq('consent_status', 'user_only')
  .gte('duration', minDuration)
  .lte('duration', maxDuration)
  .not('audio_url', 'is', null)
  .order('date', { ascending: false })
  .limit(count)

if (error) {
  console.error('Supabase 조회 실패:', error.message)
  process.exit(1)
}

const rows = (data ?? []) as unknown as SessionRow[]
if (rows.length === 0) {
  console.log('조건에 맞는 세션이 없습니다.')
  process.exit(0)
}

console.log(`조회 결과: ${rows.length}개 세션\n`)

// ── S3 키 해석 (audio_url 이 전체 URL 일 수도, 키만 저장돼 있을 수도) ──
const toS3Key = (audioUrl: string): string => {
  if (audioUrl.startsWith('http')) {
    const url = new URL(audioUrl)
    // /<bucket>/<key...> 또는 /<key...> 형태
    const parts = url.pathname.replace(/^\/+/, '').split('/')
    if (parts[0] === s3Bucket) return parts.slice(1).join('/')
    return parts.join('/')
  }
  return audioUrl.replace(/^\/+/, '')
}

// ── 다운로드 ───────────────────────────────────────────────────────────
const longDir = path.join(outDir, 'long')
fs.mkdirSync(longDir, { recursive: true })

interface SampleMeta {
  hash: string
  bucket: 'long'
  duration: number
  date: string
  s3_key: string
  file: string
}

const samples: SampleMeta[] = []

for (let i = 0; i < rows.length; i++) {
  const row = rows[i]
  const label = `[${i + 1}/${rows.length}]`

  if (!row.audio_url) {
    console.warn(`${label} audio_url 없음 — 스킵: ${row.id}`)
    continue
  }

  const hash = createHash('sha256').update(row.id).digest('hex').slice(0, 8)
  const key = toS3Key(row.audio_url)
  const ext = path.extname(key) || '.m4a'
  const fileName = `${hash}${ext}`
  const destPath = path.join(longDir, fileName)

  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: key }))
    if (!(response.Body instanceof Readable)) {
      throw new Error('Unexpected response body type')
    }
    await pipeline(response.Body, fs.createWriteStream(destPath))

    const stats = fs.statSync(destPath)
    console.log(`${label} ✓ ${hash} | ${row.duration}s | ${(stats.size / 1024 / 1024).toFixed(1)} MB`)

    samples.push({
      hash,
      bucket: 'long',
      duration: row.duration,
      date: row.date,
      s3_key: key,
      file: `long/${fileName}`,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`${label} ✗ ${hash} (key=${key}) — ${msg}`)
  }
}

// ── 메타데이터 저장 ────────────────────────────────────────────────────
const manifestPath = path.join(outDir, 'samples.json')
fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      source: supabaseUrl,
      bucket: 'long',
      duration_range_sec: [minDuration, maxDuration],
      count: samples.length,
      samples,
    },
    null,
    2,
  ),
)

console.log(`\n완료: ${samples.length}개 샘플`)
console.log(`매니페스트: ${path.resolve(manifestPath)}`)
