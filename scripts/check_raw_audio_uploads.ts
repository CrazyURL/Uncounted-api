// raw_audio_url 채워진 sessions 진단 — STAGE 1.3 업로드가 실제로 동작했는지 검증
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env' })

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

console.log(`Supabase: ${process.env.SUPABASE_URL}\n`)

// 1. raw_audio_url 채워진 sessions 전체 수
const { count: rawCount, error: e1 } = await supabase
  .from('sessions')
  .select('id', { count: 'exact', head: true })
  .not('raw_audio_url', 'is', null)

if (e1) { console.error('e1:', e1.message); process.exit(1) }
console.log(`raw_audio_url 채워진 sessions: ${rawCount}건`)

// 2. 최근 raw audio 업로드 10건 (시점 + path 패턴)
const { data: recent, error: e2 } = await supabase
  .from('sessions')
  .select('id, pid, consent_status, raw_audio_url, raw_audio_uploaded_at, gpu_upload_status')
  .not('raw_audio_url', 'is', null)
  .order('raw_audio_uploaded_at', { ascending: false })
  .limit(10)

if (e2) { console.error('e2:', e2.message); process.exit(1) }
console.log('\n최근 raw audio 업로드 10건:')
for (const r of recent ?? []) {
  const isE2eMock = r.raw_audio_url?.includes('e2e-test') || r.id?.startsWith('e2e-')
  console.log(`  ${isE2eMock ? '[MOCK]' : '[REAL]'} ${r.raw_audio_uploaded_at} ${r.consent_status} ${r.gpu_upload_status} ${r.id} → ${r.raw_audio_url}`)
}

// 3. both_agreed 세션 중 raw_audio_url 안 박힌 세션 (= 업로드 실패 또는 미발송)
const { data: missing, error: e3 } = await supabase
  .from('sessions')
  .select('id, consent_status, audio_url, raw_audio_url, raw_audio_uploaded_at')
  .eq('consent_status', 'both_agreed')
  .is('raw_audio_url', null)
  .order('raw_audio_uploaded_at', { ascending: false })
  .limit(20)

if (e3) { console.error('e3:', e3.message); process.exit(1) }
console.log(`\nboth_agreed 인데 raw_audio_url 비어있는 세션: ${missing?.length ?? 0}건 (≤20 표시)`)
for (const r of missing ?? []) {
  console.log(`  ${r.raw_audio_uploaded_at} audio_url=${r.audio_url ? 'YES' : 'NO'} ${r.id}`)
}

// 4. gpu_upload_status 분포
const { data: gpuStat, error: e4 } = await supabase
  .from('sessions')
  .select('gpu_upload_status')
  .limit(2000)

if (e4) { console.error('e4:', e4.message); process.exit(1) }
const gpuCount: Record<string, number> = {}
for (const r of gpuStat ?? []) {
  const s = (r as any).gpu_upload_status ?? 'null'
  gpuCount[s] = (gpuCount[s] ?? 0) + 1
}
console.log('\ngpu_upload_status 분포 (최근 2000건):')
for (const [k, v] of Object.entries(gpuCount)) console.log(`  ${k}: ${v}`)
