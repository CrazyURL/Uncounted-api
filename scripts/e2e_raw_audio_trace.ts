// ════════════════════════════════════════════════════════════════════
// STAGE 1.5 — E2E 1 trace 검증
// ════════════════════════════════════════════════════════════════════
//
// App + Render 없이 worker 핵심 로직만 1건 처리해 end-to-end 검증:
//   1. 가짜 sessions row INSERT (consent='both_agreed', user='cbee40db…')
//   2. 로컬 m4a → iwinv S3 raw-audio/{userId}/{sessionId}.m4a 업로드
//   3. sessions.raw_audio_url 채우기
//   4. processOneSession() 직접 호출 (워커 1 cycle)
//   5. 결과 확인:
//      - sessions 5단계 status='done'
//      - utterances rows 생성
//      - iwinv S3 utterances/{sessionId}/utt_*.wav 업로드
//
// 사용:
//   cd uncounted-api
//   npx tsx scripts/e2e_raw_audio_trace.ts
//
// 환경변수 필요 (.env):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_AUDIO_BUCKET
//   VOICE_API_URL (예: http://183.96.42.95:8001)
// ════════════════════════════════════════════════════════════════════

import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { supabaseAdmin } from '../src/lib/supabase.js'
import { uploadObject, S3_AUDIO_BUCKET } from '../src/lib/s3.js'
import { processOneSession } from '../src/services/gpu-worker.js'

// ── 테스트 설정 ─────────────────────────────────────────────────────
const TEST_USER_ID = 'cbee40db-d490-47f9-908b-b61492b6f63d'  // 919 dummy 의 owner (auth.users 보존됨)
const TEST_SESSION_ID = `test_e2e_${Date.now().toString(36)}`

// 기본 샘플 경로 — repo 내 scripts/sample-audio/test-utterance.m4a
// 환경변수 SAMPLE_AUDIO_PATH 로 override 가능 (로컬 voicebank 사용 시)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLE_AUDIO_PATH =
  process.env.SAMPLE_AUDIO_PATH ?? resolve(__dirname, 'sample-audio/test-utterance.m4a')

async function main() {
  console.log('━'.repeat(60))
  console.log('STAGE 1.5 — E2E 1 trace 검증')
  console.log('━'.repeat(60))
  console.log(`session_id: ${TEST_SESSION_ID}`)
  console.log(`user_id:    ${TEST_USER_ID}`)
  console.log(`audio:      ${SAMPLE_AUDIO_PATH}`)
  console.log(`voice_api:  ${process.env.VOICE_API_URL ?? '(not set — 워커가 localhost:8001 시도)'}`)

  // ── 1. 샘플 오디오 로드 ─────────────────────────────────────────
  const audioBuffer = await readFile(SAMPLE_AUDIO_PATH)
  console.log(`\n[1] 오디오 로드: ${(audioBuffer.byteLength / 1024).toFixed(1)} KB`)

  // ── 2. sessions row INSERT ────────────────────────────────────
  const now = new Date().toISOString()
  const { error: insertErr } = await supabaseAdmin.from('sessions').insert({
    id: TEST_SESSION_ID,
    user_id: TEST_USER_ID,
    title: 'E2E 검증 — 통화 녹음 (문소라 샘플)',
    duration: 30,
    date: now.slice(0, 10),
    consent_status: 'both_agreed',
    consented_at: now,
    upload_status: 'UPLOADED',
    gpu_upload_status: 'pending',
    stt_status: 'pending',
    diarize_status: 'pending',
    gpu_pii_status: 'pending',
    quality_status: 'pending',
    audio_url: 'e2e-test-local-path.m4a', // BM v9 잔존 컬럼 — NULL 허용 안 할 수 있어 더미
    asset_type: 'voice',
  })
  if (insertErr) {
    console.error('[1.5 FAIL] sessions INSERT 실패:', insertErr.message)
    process.exit(1)
  }
  console.log(`[2] sessions row INSERT OK`)

  // ── 3. iwinv S3 raw audio 업로드 ────────────────────────────────
  const rawPath = `raw-audio/${TEST_USER_ID}/${TEST_SESSION_ID}.m4a`
  await uploadObject(
    S3_AUDIO_BUCKET,
    rawPath,
    new Uint8Array(audioBuffer),
    'audio/mp4',
  )
  console.log(`[3] S3 업로드 OK: ${rawPath}`)

  // ── 4. sessions.raw_audio_url 등 채우기 ────────────────────────
  const { error: updateErr } = await supabaseAdmin
    .from('sessions')
    .update({
      raw_audio_url: rawPath,
      raw_audio_size: audioBuffer.byteLength,
      raw_audio_uploaded_at: new Date().toISOString(),
    })
    .eq('id', TEST_SESSION_ID)
  if (updateErr) {
    console.error('[1.5 FAIL] sessions UPDATE 실패:', updateErr.message)
    process.exit(1)
  }
  console.log(`[4] sessions.raw_audio_url UPDATE OK — 워커 큐 진입`)

  // ── 5. 워커 1 cycle 직접 호출 ───────────────────────────────────
  console.log(`\n[5] processOneSession() 호출...`)
  const startedAt = Date.now()
  const processed = await processOneSession()
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  if (!processed) {
    console.error(`[1.5 FAIL] processOneSession 이 false 반환 — 큐 비어있음 또는 픽업 실패`)
    process.exit(1)
  }
  console.log(`[5] processOneSession 완료 (${elapsedSec}s)`)

  // ── 6. 결과 검증 ─────────────────────────────────────────────────
  const { data: session, error: selectErr } = await supabaseAdmin
    .from('sessions')
    .select(
      'gpu_upload_status, stt_status, diarize_status, gpu_pii_status, quality_status, utterance_count',
    )
    .eq('id', TEST_SESSION_ID)
    .single()
  if (selectErr || !session) {
    console.error('[1.5 FAIL] sessions 조회 실패:', selectErr?.message)
    process.exit(1)
  }

  const { data: utts, count: uttCount } = await supabaseAdmin
    .from('utterances')
    .select('id, sequence_order, speaker_id, duration_sec, storage_path', {
      count: 'exact',
    })
    .eq('session_id', TEST_SESSION_ID)
    .order('sequence_order', { ascending: true })

  console.log(`\n━━━ 결과 ━━━`)
  console.log(`sessions.gpu_upload_status: ${session.gpu_upload_status}`)
  console.log(`sessions.stt_status:        ${session.stt_status}`)
  console.log(`sessions.diarize_status:    ${session.diarize_status}`)
  console.log(`sessions.gpu_pii_status:    ${session.gpu_pii_status}`)
  console.log(`sessions.quality_status:    ${session.quality_status}`)
  console.log(`sessions.utterance_count:   ${session.utterance_count}`)
  console.log(`utterances 행 수:           ${uttCount}`)
  if (utts && utts.length > 0) {
    console.log(`\n첫 발화 3건:`)
    for (const u of utts.slice(0, 3)) {
      console.log(`  ${u.id} | speaker=${u.speaker_id} | dur=${u.duration_sec}s | ${u.storage_path}`)
    }
  }

  const allDone =
    session.gpu_upload_status === 'done' &&
    session.stt_status === 'done' &&
    session.diarize_status === 'done' &&
    session.gpu_pii_status === 'done' &&
    session.quality_status === 'done'

  if (allDone && (uttCount ?? 0) > 0) {
    console.log(`\n✅ STAGE 1.5 PASS — 5단계 모두 done, utterances ${uttCount}건 생성`)
    console.log(`   다음: STAGE 2 (운영 안정성) 진행 가능`)
  } else {
    console.log(`\n❌ STAGE 1.5 FAIL — 결과가 기대와 다름`)
    console.log(`   STAGE 2~ 진행 금지. 워커 로직 점검 필요.`)
    process.exit(2)
  }
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
