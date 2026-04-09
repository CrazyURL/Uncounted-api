// ── consent_status 초기화 스크립트 ──────────────────────────────────────
// PUBLIC_CONSENTED → PRIVATE 일괄 변경 (테스트용)
//
// 사용법: npx tsx scripts/reset-consent-to-private.ts [--dry-run]
//
// 변경 대상:
//   - billable_units.consent_status: 'PUBLIC_CONSENTED' → 'PRIVATE'
//   - sessions.consent_status:       'PUBLIC_CONSENTED' → 'locked'
//
// 필수 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js'

// ── 환경변수 로드 ──────────────────────────────────────────────────────
const { config } = await import('dotenv')
config({ path: '.env.development' })
config({ path: '.env' })

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('ERROR: SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 미설정')
  process.exit(1)
}

// ── CLI 옵션 ───────────────────────────────────────────────────────────
const isDryRun = process.argv.includes('--dry-run')

// ── Supabase 클라이언트 ────────────────────────────────────────────────
const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

console.log(`\n=== consent_status 초기화 (${isDryRun ? 'DRY-RUN' : '실제 실행'}) ===\n`)

// ── 현황 조회 ──────────────────────────────────────────────────────────
const { count: buCount } = await supabase
  .from('billable_units')
  .select('*', { count: 'exact', head: true })
  .eq('consent_status', 'PUBLIC_CONSENTED')

const { count: sessionCount } = await supabase
  .from('sessions')
  .select('*', { count: 'exact', head: true })
  .eq('consent_status', 'PUBLIC_CONSENTED')

console.log(`billable_units PUBLIC_CONSENTED: ${buCount ?? 0}건`)
console.log(`sessions       PUBLIC_CONSENTED: ${sessionCount ?? 0}건`)

if ((buCount ?? 0) === 0 && (sessionCount ?? 0) === 0) {
  console.log('\n변경 대상 없음. 종료.')
  process.exit(0)
}

if (isDryRun) {
  console.log('\n[DRY-RUN] 실제 변경 없음. --dry-run 플래그 제거 후 재실행하세요.')
  process.exit(0)
}

// ── billable_units 업데이트 ────────────────────────────────────────────
const { error: buError } = await supabase
  .from('billable_units')
  .update({ consent_status: 'PRIVATE' })
  .eq('consent_status', 'PUBLIC_CONSENTED')

if (buError) {
  console.error('billable_units 업데이트 실패:', buError.message)
  process.exit(1)
}
console.log(`\nbillable_units: ${buCount ?? 0}건 → PRIVATE`)

// ── sessions 업데이트 ──────────────────────────────────────────────────
const { error: sessionError } = await supabase
  .from('sessions')
  .update({ consent_status: 'locked' })
  .eq('consent_status', 'PUBLIC_CONSENTED')

if (sessionError) {
  console.error('sessions 업데이트 실패:', sessionError.message)
  process.exit(1)
}
console.log(`sessions:       ${sessionCount ?? 0}건 → locked`)

console.log('\n완료.')
