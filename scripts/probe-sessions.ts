// 벤치마크 샘플 가용성 진단
import { createClient } from '@supabase/supabase-js'

const { config } = await import('dotenv')
config({ path: '.env' })

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

console.log(`Supabase: ${process.env.SUPABASE_URL}\n`)

// 1. consent_status 분포
const { data: statusRows, error: e1 } = await supabase
  .from('sessions')
  .select('consent_status')
  .limit(2000)

if (e1) { console.error('e1:', e1.message); process.exit(1) }

const statusCount: Record<string, number> = {}
for (const r of statusRows ?? []) {
  const s = (r as any).consent_status ?? 'null'
  statusCount[s] = (statusCount[s] ?? 0) + 1
}
console.log('consent_status 분포 (최근 2000건):')
for (const [k, v] of Object.entries(statusCount)) console.log(`  ${k}: ${v}`)

// 2. duration 버킷 분포 (audio_url 있는 것만)
const { data: durRows, error: e2 } = await supabase
  .from('sessions')
  .select('duration, consent_status, audio_url')
  .not('audio_url', 'is', null)
  .limit(2000)

if (e2) { console.error('e2:', e2.message); process.exit(1) }

const buckets = { '0-60': 0, '60-120': 0, '120-600': 0, '600-1800': 0, '1800-3600': 0, '3600+': 0 }
const both_agreed_buckets = { ...buckets }
for (const r of durRows ?? []) {
  const d = (r as any).duration as number
  const key =
    d < 60 ? '0-60' :
    d < 120 ? '60-120' :
    d < 600 ? '120-600' :
    d < 1800 ? '600-1800' :
    d < 3600 ? '1800-3600' : '3600+'
  buckets[key as keyof typeof buckets]++
  if ((r as any).consent_status === 'both_agreed') {
    both_agreed_buckets[key as keyof typeof both_agreed_buckets]++
  }
}
console.log('\nduration 버킷 (audio_url 있는 세션, 전체):')
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}s: ${v}`)

console.log('\nduration 버킷 (consent_status=both_agreed):')
for (const [k, v] of Object.entries(both_agreed_buckets)) console.log(`  ${k}s: ${v}`)
