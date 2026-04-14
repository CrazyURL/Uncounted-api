// Phantom SPEAKER_02+ 발생 sessions를 DB에서 찾고 sample_data/Call 매칭.
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import { config } from 'dotenv'
config({ path: '.env.development' })

const SAMPLE_DIR = '/Users/gdash/project/uncounted-project/sample_data/Call'

const s = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

// SPEAKER_02 이상이 있는 utterances → session_id 집계
const { data: phantoms, error } = await s
  .from('utterances')
  .select('session_id, speaker_id')
  .in('speaker_id', ['SPEAKER_02', 'SPEAKER_03', 'SPEAKER_04'])
if (error) { console.error(error.message); process.exit(1) }

const phantomCount = new Map()
for (const u of phantoms ?? []) {
  phantomCount.set(u.session_id, (phantomCount.get(u.session_id) ?? 0) + 1)
}
console.log(`Phantom-affected sessions: ${phantomCount.size}\n`)

if (phantomCount.size === 0) { process.exit(0) }

// 해당 sessions 메타 조회
const ids = [...phantomCount.keys()]
const { data: sessions } = await s
  .from('sessions')
  .select('id, title, duration')
  .in('id', ids)
  .gte('duration', 300)
  .lte('duration', 3600)
  .order('duration', { ascending: true })

const localFiles = new Set(fs.readdirSync(SAMPLE_DIR).filter(f => f.endsWith('.m4a')))

console.log('# 후보 (duration 5분~60분, sample_data/Call 매칭 가능 우선)')
console.log('  session_id        dur    phantom  local_file?')
const matched = []
for (const r of sessions ?? []) {
  // title → 파일명 매칭 시도 (title이 이미 '통화 녹음 ...' 형식)
  const candidate = `${r.title}.m4a`
  const exists = localFiles.has(candidate)
  const ph = phantomCount.get(r.id)
  const dur = r.duration
  const flag = exists ? 'YES' : 'no'
  console.log(`  ${r.id}  ${String(dur).padStart(4)}s  ${String(ph).padStart(3)}     ${flag.padEnd(3)}  ${candidate}`)
  if (exists) matched.push({ id: r.id, file: candidate, duration: dur, phantom: ph })
}

console.log(`\n# 매칭된 로컬 파일 ${matched.length}건 (verify_diarization_option_d.mjs targets에 복사 가능)`)
for (const m of matched.slice(0, 10)) {
  console.log(`  { id: '${m.id}', file: ${JSON.stringify(m.file)} },  // ${m.duration}s, phantom=${m.phantom}`)
}
