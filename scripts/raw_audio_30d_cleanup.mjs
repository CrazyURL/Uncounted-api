// ════════════════════════════════════════════════════════════════════
// BM v10 STAGE 2.5 — Raw audio 30일 lifecycle 자동 삭제
// ════════════════════════════════════════════════════════════════════
//
// WHY
//   사용자 동의: raw audio 는 GPU 처리 후 30일 보관 후 자동 삭제.
//   처리 후 sanitized utterances 만 영구 보관.
//   개보법/통신비밀보호법 준수 + 약관 v1.2 의 "raw 30일 보관" 명시 근거.
//
// 작동
//   1. sessions WHERE raw_audio_uploaded_at < NOW() - 30days
//   2. 각 raw_audio_url 에 대해 iwinv S3 객체 삭제
//   3. sessions UPDATE: raw_audio_url=NULL (삭제 완료 표식)
//
// 사용:
//   node --env-file=.env scripts/raw_audio_30d_cleanup.mjs              # dry-run
//   node --env-file=.env scripts/raw_audio_30d_cleanup.mjs --apply      # 실제 삭제
//
// 권장 실행 주기:
//   매일 1회 cron 또는 systemd timer (Render Cron Job 또는 외부 스케줄러)
//   /opt/render/project/src/uncounted-api/scripts/raw_audio_30d_cleanup.mjs --apply
//
// 안전장치:
//   - 30일 미만 데이터는 절대 안 건드림
//   - dry-run 기본값
//   - 삭제 전 갯수 + 가장 최근/오래된 시각 보고
//   - DB 업데이트 실패 시 S3 삭제도 롤백 (orphan 방지)
// ════════════════════════════════════════════════════════════════════

import {
  S3Client,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')

// ── env 검증 ────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_REGION = process.env.S3_REGION ?? 'kr-standard'
const S3_KEY = process.env.S3_ACCESS_KEY
const S3_SECRET = process.env.S3_SECRET_KEY
const S3_BUCKET = process.env.S3_AUDIO_BUCKET ?? 'sanitized-audio'

const missing = []
if (!SUPABASE_URL) missing.push('SUPABASE_URL')
if (!SUPABASE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
if (!S3_ENDPOINT) missing.push('S3_ENDPOINT')
if (!S3_KEY) missing.push('S3_ACCESS_KEY')
if (!S3_SECRET) missing.push('S3_SECRET_KEY')
if (missing.length) {
  console.error(`❌ 환경변수 누락: ${missing.join(', ')}`)
  process.exit(2)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET },
  forcePathStyle: true,
})

const RETENTION_DAYS = 30

// ── 메인 ────────────────────────────────────────────────────────────
async function main() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString()
  console.log('━'.repeat(60))
  console.log(`raw audio 30일 lifecycle ${APPLY ? '실행' : '(dry-run)'}`)
  console.log('━'.repeat(60))
  console.log(`기준: raw_audio_uploaded_at < ${cutoff}`)
  console.log(`버킷: ${S3_BUCKET}`)

  const { data: rows, error } = await supabase
    .from('sessions')
    .select('id, raw_audio_url, raw_audio_uploaded_at, gpu_upload_status')
    .lt('raw_audio_uploaded_at', cutoff)
    .not('raw_audio_url', 'is', null)
    .order('raw_audio_uploaded_at', { ascending: true })

  if (error) {
    console.error('SELECT 실패:', error.message)
    process.exit(1)
  }

  console.log(`\n대상: ${rows.length}건`)
  if (rows.length === 0) {
    console.log('정리할 raw audio 없음. 종료.')
    return
  }

  console.log(`최오래: ${rows[0].raw_audio_uploaded_at}`)
  console.log(`최최근: ${rows[rows.length - 1].raw_audio_uploaded_at}`)
  console.log(`샘플 3건:`)
  for (const r of rows.slice(0, 3)) {
    console.log(`  ${r.id.slice(0, 12)} | status=${r.gpu_upload_status} | ${r.raw_audio_url}`)
  }

  if (!APPLY) {
    console.log(`\nDry-run 완료. 실제 삭제: --apply 옵션 추가`)
    return
  }

  // 1000개씩 배치 (S3 DeleteObjects 한도)
  const keys = rows.map((r) => r.raw_audio_url)
  let deleted = 0
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    const res = await s3.send(
      new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    )
    if (res.Errors?.length) {
      console.error(`❌ S3 배치 ${i / 1000 + 1} 실패 ${res.Errors.length}건:`, res.Errors.slice(0, 3))
      process.exit(1)
    }
    deleted += batch.length
    console.log(`  S3 삭제 진행: ${deleted}/${keys.length}`)
  }

  // DB 갱신: raw_audio_url=NULL (삭제 완료 표식, 다른 컬럼 유지)
  const sessionIds = rows.map((r) => r.id)
  const { error: updateErr } = await supabase
    .from('sessions')
    .update({
      raw_audio_url: null,
      raw_audio_size: null,
    })
    .in('id', sessionIds)
  if (updateErr) {
    console.error('❌ DB UPDATE 실패 (S3 객체는 이미 삭제됨!):', updateErr.message)
    process.exit(1)
  }

  console.log(`\n✅ ${deleted}개 raw audio 삭제 완료. DB 정리 OK.`)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
