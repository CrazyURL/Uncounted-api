// ── Voice API Option D 회귀 검증 ─────────────────────────────────────
// 용도: 화자분리 옵션 D (force_two_speakers) 효과 측정.
//   - 4 sessions의 원본 m4a를 로컬 sample_data/Call에서 로드
//   - voice-api에 POST /api/v1/transcribe (multipart)
//   - GET /api/v1/jobs/{taskId} 폴링
//   - 결과 JSON에서 화자 분포 집계
//   - 기존 utterances 테이블 (옵션 D OFF 당시) 분포와 비교
//
// DB write 없음. tmp 파일 없음 (로컬 원본 직접 사용).
//
// 사용법:
//   cd uncounted-api
//   VOICE_API_URL=http://183.96.42.95:8001 node scripts/verify_diarization_option_d.mjs

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { config } from 'dotenv'

config({ path: '.env.development' })

const VOICE_API = process.env.VOICE_API_URL || 'http://183.96.42.95:8001'
const SAMPLE_DIR = '/Users/gdash/project/uncounted-project/sample_data/Call'
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 15 * 60 * 1000

// session_id → sample_data/Call 파일명 매핑.
// Phantom SPEAKER_02+ 가 baseline 결과에 존재했던 케이스 — 옵션 D 효과 결정적 검증.
const targets = [
  { id: '7b2803baa5f6fa8d', file: '통화 녹음 김곰박_260403_185311.m4a' },     // 366s,  phantom=17
  { id: 'c8bfc028c5fbb5fd', file: '통화 녹음 임명훈_260317_210002.m4a' },     // 993s,  phantom=75
  { id: 'a413c7bc6209626b', file: '통화 녹음 임명훈_260313_193223.m4a' },     // 1310s, phantom=50
  { id: '71ab5b257f263e0d', file: '통화 녹음 문식환_260316_212642.m4a' },     // 1708s, phantom=73
]

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

async function postTranscribe(filePath) {
  const buf = fs.readFileSync(filePath)
  const blob = new Blob([buf], { type: 'audio/m4a' })
  const fd = new FormData()
  fd.append('file', blob, path.basename(filePath))
  const url = `${VOICE_API}/api/v1/transcribe?language=ko&diarize=true&mask_pii=true&enable_name_masking=true&split_by_utterance=true&split_by_speaker=true`
  const r = await fetch(url, { method: 'POST', body: fd })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`POST /transcribe ${r.status}: ${text.slice(0, 200)}`)
  }
  const j = await r.json()
  return j.task_id
}

async function pollJob(taskId) {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const r = await fetch(`${VOICE_API}/api/v1/jobs/${taskId}`)
    const text = await r.text()
    let j = null
    try { j = JSON.parse(text) } catch {}
    if (r.ok && j) {
      if (j.status === 'completed') return j
      if (j.status === 'failed') {
        throw new Error(`job failed: ${JSON.stringify(j).slice(0, 400)}`)
      }
    } else if (r.status === 500) {
      throw new Error(`job 500: ${text.slice(0, 400)}`)
    }
    await new Promise(res => setTimeout(res, POLL_INTERVAL_MS))
  }
  throw new Error(`poll timeout after ${POLL_TIMEOUT_MS / 1000}s`)
}

function aggregateSpeakers(jobResult) {
  const utts = jobResult?.result?.utterances || jobResult?.utterances || []
  const cnt = {}
  for (const u of utts) {
    const sp = u.speaker_id || u.speaker || 'UNKNOWN'
    cnt[sp] = (cnt[sp] ?? 0) + 1
  }
  return { total: utts.length, distribution: cnt }
}

async function fetchExistingDistribution(sessionId) {
  const { data } = await supabase
    .from('utterances')
    .select('speaker_id')
    .eq('session_id', sessionId)
  const cnt = {}
  for (const u of data ?? []) cnt[u.speaker_id] = (cnt[u.speaker_id] ?? 0) + 1
  return { total: data?.length ?? 0, distribution: cnt }
}

async function main() {
  console.log(`Voice API:  ${VOICE_API}`)
  console.log(`Sample dir: ${SAMPLE_DIR}`)
  console.log(`Targets:    ${targets.length}\n`)

  // 사전 검증: 모든 파일이 존재하는지
  for (const t of targets) {
    const p = path.join(SAMPLE_DIR, t.file)
    if (!fs.existsSync(p)) {
      console.error(`MISSING: ${p}`)
      process.exit(1)
    }
  }

  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, title, duration')
    .in('id', targets.map(t => t.id))
  const sessionMap = new Map((sessions ?? []).map(s => [s.id, s]))

  const results = []
  for (const t of targets) {
    const session = sessionMap.get(t.id) || { id: t.id, title: t.file, duration: 0 }
    const tag = `[${t.id.slice(0, 8)}]`
    const filePath = path.join(SAMPLE_DIR, t.file)
    const fileSize = fs.statSync(filePath).size

    console.log(`${tag} ${session.duration}s  ${session.title}`)

    const before = await fetchExistingDistribution(t.id)
    const beforeStr = Object.entries(before.distribution).map(([k, v]) => `${k}:${v}`).join(' ')
    console.log(`  before  total=${String(before.total).padStart(3)}  speakers=${Object.keys(before.distribution).length}  ${beforeStr}`)
    console.log(`  file    ${(fileSize / 1024 / 1024).toFixed(1)}MB`)

    let after = null
    let errorMsg = null
    const startMs = Date.now()
    try {
      const taskId = await postTranscribe(filePath)
      console.log(`  task_id=${taskId}  (polling…)`)

      const result = await pollJob(taskId)
      after = aggregateSpeakers(result)
      const afterStr = Object.entries(after.distribution).map(([k, v]) => `${k}:${v}`).join(' ')
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
      const rtf = session.duration ? (session.duration / Number(elapsed)).toFixed(1) : '?'
      const flag = Object.keys(after.distribution).length > 2 ? ' >2 speakers' : ''
      console.log(`  after   total=${String(after.total).padStart(3)}  speakers=${Object.keys(after.distribution).length}  ${afterStr}  | ${elapsed}s realtime=${rtf}x${flag}`)
    } catch (e) {
      errorMsg = e.message || String(e) || 'Unknown'
      console.log(`  ERROR: ${errorMsg}`)
      if (e.stack) console.log(`  ${e.stack.split('\n').slice(0, 4).join('\n  ')}`)
    }

    results.push({ id: t.id, session, before, after, errorMsg })
    console.log()
  }

  console.log('=== summary ===')
  let okCount = 0
  let phantomCount = 0
  for (const r of results) {
    if (r.errorMsg || !r.after) {
      console.log(`  ${r.id.slice(0, 8)}  ERROR  ${r.errorMsg ?? ''}`)
      continue
    }
    const speakerCount = Object.keys(r.after.distribution).length
    const hasPhantom = r.after.distribution['SPEAKER_02'] != null || r.after.distribution['SPEAKER_03'] != null
    const beforeSpeakers = Object.keys(r.before.distribution).length
    const beforeHadPhantom = r.before.distribution['SPEAKER_02'] != null || r.before.distribution['SPEAKER_03'] != null
    if (speakerCount <= 2 && !hasPhantom) okCount++
    if (hasPhantom) phantomCount++
    const tag = beforeHadPhantom && !hasPhantom ? 'phantom REMOVED'
      : hasPhantom ? 'phantom STILL'
      : 'no prior phantom'
    console.log(`  ${r.id.slice(0, 8)}  ${tag}  (before=${beforeSpeakers} → after=${speakerCount})`)
  }
  console.log(`\nOK: ${okCount}/${results.length}  phantoms: ${phantomCount}`)
  process.exit(phantomCount === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
