// ── 세션 ID 마이그레이션 스크립트 ─────────────────────────────────────────
// 기존 randomUUID 기반 세션 ID → HMAC(ANDROID_ID) 기반 결정론적 ID로 변환.
//
// 사용법:
//   npx tsx scripts/migrate-session-ids.ts --android-id <ANDROID_ID> [--user-id <USER_ID>] [--dry-run]
//
// 필수:
//   --android-id   기기의 ANDROID_ID (adb shell settings get secure android_id)
//
// 선택:
//   --user-id      특정 사용자만 마이그레이션 (미지정 시 전체)
//   --dry-run      실행하지 않고 변경 내역만 출력
//
// 필수 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// HMAC 키: 앱의 VITE_SESSION_HMAC_KEY와 동일값 사용

import { createClient } from '@supabase/supabase-js'
import { createHmac } from 'node:crypto'

// ── 환경변수 로드 ──────────────────────────────────────────────────────
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'
const { config } = await import('dotenv')
config({ path: envFile })

// ── CLI 파싱 ───────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')

function getArg(name: string): string | null {
  const idx = args.indexOf(name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
}

const androidId = getArg('--android-id')
const filterUserId = getArg('--user-id')

if (!androidId) {
  console.error('ERROR: --android-id 필수\n')
  console.error('사용법: npx tsx scripts/migrate-session-ids.ts --android-id <ANDROID_ID> [--user-id <USER_ID>] [--dry-run]')
  console.error('확인:   adb shell settings get secure android_id')
  process.exit(1)
}

// ── HMAC 키 ────────────────────────────────────────────────────────────
// 앱의 VITE_SESSION_HMAC_KEY와 동일한 값
const HMAC_KEY_HEX = '4d255e63f049b3154981fcd0fe7efcc34b77b178a34d11deca50ab490ee654cd'

function computeNewSessionId(filePath: string): string {
  const input = `${androidId}:${filePath}`
  const hmac = createHmac('sha256', Buffer.from(HMAC_KEY_HEX, 'hex'))
  hmac.update(input)
  return hmac.digest('hex').slice(0, 16)
}

// ── Supabase 클라이언트 ────────────────────────────────────────────────
const url = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  throw new Error('Missing: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── FK 테이블 목록 (ON DELETE CASCADE) ─────────────────────────────────
const FK_TABLES = [
  'score_components',
  'labels',
  'campaign_matches',
  'session_labels',
  'billable_units',
  'session_chunks',
  'transcript_chunks',
] as const

// session_chunks, transcript_chunks: UNIQUE(session_id, chunk_index) 제약 있음
const TABLES_WITH_CHUNK_UNIQUE = new Set(['session_chunks', 'transcript_chunks'])

// ── 타입 ───────────────────────────────────────────────────────────────
type SessionRow = {
  id: string
  user_id: string | null
  call_record_id: string | null
}

type Migration = {
  oldId: string
  newId: string
  callRecordId: string
  userId: string | null
}

// ── 세션 조회 ──────────────────────────────────────────────────────────
async function loadSessions(): Promise<SessionRow[]> {
  const all: SessionRow[] = []
  let page = 0
  const PAGE_SIZE = 1000

  while (true) {
    let query = supabase
      .from('sessions')
      .select('id, user_id, call_record_id')
      .not('call_record_id', 'is', null)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

    if (filterUserId) {
      query = query.eq('user_id', filterUserId)
    }

    const { data, error } = await query
    if (error) throw new Error(`sessions 조회 실패: ${error.message}`)
    if (!data || data.length === 0) break
    all.push(...(data as SessionRow[]))
    if (data.length < PAGE_SIZE) break
    page++
  }

  return all
}

// ── 마이그레이션 매핑 생성 ─────────────────────────────────────────────
function buildMigrations(sessions: SessionRow[]): Migration[] {
  const migrations: Migration[] = []

  for (const s of sessions) {
    if (!s.call_record_id) continue
    const newId = computeNewSessionId(s.call_record_id)
    if (newId === s.id) continue
    migrations.push({
      oldId: s.id,
      newId,
      callRecordId: s.call_record_id,
      userId: s.user_id,
    })
  }

  return migrations
}

// ── 단건 마이그레이션 실행 ─────────────────────────────────────────────
async function migrateOne(m: Migration): Promise<{ fkMoved: Record<string, number>; transcriptMoved: boolean }> {
  const fkMoved: Record<string, number> = {}

  // 1. 기존 세션 데이터 조회
  const { data: oldSession, error: fetchErr } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', m.oldId)
    .single()

  if (fetchErr || !oldSession) {
    console.error(`  [SKIP] ${m.oldId} 조회 실패: ${fetchErr?.message}`)
    return { fkMoved, transcriptMoved: false }
  }

  // 2. new ID로 세션이 이미 존재하는지 확인
  const { data: existingNew } = await supabase
    .from('sessions')
    .select('id')
    .eq('id', m.newId)
    .maybeSingle()

  if (existingNew) {
    // new ID 세션이 이미 존재 → FK 데이터만 이동 후 old 삭제
    console.log(`  [EXISTS] ${m.newId} 이미 존재 — FK 이동 후 old 삭제`)
  } else {
    // 3. new ID로 세션 INSERT
    const newRow = { ...oldSession, id: m.newId }
    const { error: insertErr } = await supabase
      .from('sessions')
      .insert(newRow)

    if (insertErr) {
      console.error(`  [ERROR] INSERT ${m.newId}: ${insertErr.message}`)
      return { fkMoved, transcriptMoved: false }
    }
  }

  // 4. FK 테이블 이동
  for (const table of FK_TABLES) {
    if (TABLES_WITH_CHUNK_UNIQUE.has(table)) {
      // UNIQUE(session_id, chunk_index) 충돌 방지: winner에 이미 있는 chunk_index는 삭제
      const { data: existingChunks } = await supabase
        .from(table)
        .select('chunk_index')
        .eq('session_id', m.newId)

      const existingIndexes = new Set((existingChunks ?? []).map((c: any) => c.chunk_index))

      if (existingIndexes.size > 0) {
        // 충돌하는 loser 행 삭제
        await supabase
          .from(table)
          .delete()
          .eq('session_id', m.oldId)
          .in('chunk_index', [...existingIndexes])
      }
    }

    const { count, error: updateErr } = await supabase
      .from(table)
      .update({ session_id: m.newId } as any, { count: 'exact' })
      .eq('session_id', m.oldId)

    if (updateErr) {
      console.error(`  [ERROR] ${table} UPDATE: ${updateErr.message}`)
    } else {
      fkMoved[table] = count ?? 0
    }
  }

  // 5. transcripts (PK = session_id, FK 없음)
  let transcriptMoved = false
  const { data: existingTranscript } = await supabase
    .from('transcripts')
    .select('session_id')
    .eq('session_id', m.newId)
    .maybeSingle()

  if (existingTranscript) {
    // new ID에 이미 transcript 존재 → old 것 삭제
    await supabase.from('transcripts').delete().eq('session_id', m.oldId)
  } else {
    const { count } = await supabase
      .from('transcripts')
      .update({ session_id: m.newId } as any, { count: 'exact' })
      .eq('session_id', m.oldId)

    transcriptMoved = (count ?? 0) > 0
  }

  // 6. old 세션 삭제 (남은 FK는 CASCADE로 정리)
  const { error: deleteErr } = await supabase
    .from('sessions')
    .delete()
    .eq('id', m.oldId)

  if (deleteErr) {
    console.error(`  [ERROR] DELETE ${m.oldId}: ${deleteErr.message}`)
  }

  return { fkMoved, transcriptMoved }
}

// ── 메인 ───────────────────────────────────────────────────────────────
async function main() {
  console.log('════════════════════════════════════════════════════════════')
  console.log('  세션 ID 마이그레이션 (randomUUID → HMAC)')
  console.log(`  모드: ${isDryRun ? 'DRY-RUN' : 'LIVE'}`)
  console.log(`  ANDROID_ID: ${androidId}`)
  if (filterUserId) console.log(`  User ID: ${filterUserId}`)
  console.log('════════════════════════════════════════════════════════════\n')

  const sessions = await loadSessions()
  console.log(`[조회] 세션 ${sessions.length}건 (call_record_id 있는 것만)\n`)

  const migrations = buildMigrations(sessions)

  if (migrations.length === 0) {
    console.log('[결과] 변경 대상 없음. 모든 세션 ID가 이미 최신입니다.')
    return
  }

  console.log(`[변경] ${migrations.length}건 마이그레이션 대상\n`)

  // dry-run: 매핑만 출력
  if (isDryRun) {
    for (const m of migrations) {
      console.log(`  ${m.oldId} → ${m.newId}  (${m.callRecordId})`)
    }
    console.log(`\n  --dry-run 제거 후 다시 실행하면 마이그레이션이 실행됩니다.`)
    return
  }

  // 실행
  const totalFkMoved: Record<string, number> = {}
  let migratedCount = 0
  let transcriptCount = 0

  for (const m of migrations) {
    console.log(`[${migratedCount + 1}/${migrations.length}] ${m.oldId} → ${m.newId}`)
    const { fkMoved, transcriptMoved } = await migrateOne(m)
    migratedCount++
    if (transcriptMoved) transcriptCount++

    for (const [table, count] of Object.entries(fkMoved)) {
      totalFkMoved[table] = (totalFkMoved[table] ?? 0) + count
    }
  }

  console.log('\n════════════════════════════════════════════════════════════')
  console.log('  결과 요약')
  console.log('════════════════════════════════════════════════════════════')
  console.log(`  마이그레이션 완료: ${migratedCount}건`)
  console.log(`  transcript 이동:   ${transcriptCount}건`)
  for (const [table, count] of Object.entries(totalFkMoved)) {
    if (count > 0) console.log(`  ${table}: ${count}행 이동`)
  }
  console.log('════════════════════════════════════════════════════════════')
}

main().catch((err) => {
  console.error('[FATAL]', err)
  process.exit(1)
})
