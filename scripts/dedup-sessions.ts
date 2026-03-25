// ── 세션 중복 제거 스크립트 ─────────────────────────────────────────────
// 사용법: npx tsx scripts/dedup-sessions.ts [--dry-run]
//
// user_id + title 기준으로 중복 세션을 찾아 최신(updated_at DESC) 1건만 남기고 삭제.
// sessions ON DELETE CASCADE로 연결된 7개 테이블 자동 정리.
// transcripts 테이블은 FK 없으므로 별도 삭제.
//
// 필수 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js'

// ── 환경변수 로드 ──────────────────────────────────────────────────────
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'
const { config } = await import('dotenv')
config({ path: envFile })

// ── CLI 옵션 ───────────────────────────────────────────────────────────
const isDryRun = process.argv.includes('--dry-run')

// ── Supabase 클라이언트 ────────────────────────────────────────────────
const url = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  throw new Error(
    'Missing environment variables:\n' +
    '- SUPABASE_URL\n' +
    '- SUPABASE_SERVICE_ROLE_KEY',
  )
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── 타입 ───────────────────────────────────────────────────────────────

type SessionRow = {
  id: string
  user_id: string | null
  title: string
  updated_at: string
  upload_status: string | null
}

type DupGroup = {
  userId: string
  title: string
  winner: SessionRow
  losers: SessionRow[]
}

// ── 중복 조회 ──────────────────────────────────────────────────────────

async function findDuplicates(): Promise<DupGroup[]> {
  // 전체 세션 로드 (user_id + title 기준 정렬)
  const allSessions: SessionRow[] = []
  let page = 0
  const PAGE_SIZE = 1000

  while (true) {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, user_id, title, updated_at, upload_status')
      .order('updated_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

    if (error) throw new Error(`sessions 조회 실패: ${error.message}`)
    if (!data || data.length === 0) break
    allSessions.push(...(data as SessionRow[]))
    if (data.length < PAGE_SIZE) break
    page++
  }

  console.log(`[조회] 전체 세션: ${allSessions.length}건`)

  // user_id + title 기준 그룹화
  const groups = new Map<string, SessionRow[]>()
  for (const s of allSessions) {
    const key = `${s.user_id ?? 'null'}::${s.title}`
    const group = groups.get(key)
    if (group) {
      group.push(s)
    } else {
      groups.set(key, [s])
    }
  }

  // 2건 이상인 그룹만 필터
  const dupGroups: DupGroup[] = []
  for (const [, sessions] of groups) {
    if (sessions.length < 2) continue

    // updated_at DESC 정렬 (최신이 첫 번째)
    const sorted = [...sessions].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )
    const [winner, ...losers] = sorted
    dupGroups.push({
      userId: winner.user_id ?? 'null',
      title: winner.title,
      winner,
      losers,
    })
  }

  return dupGroups
}

// ── 삭제 실행 ──────────────────────────────────────────────────────────

async function deleteLosers(groups: DupGroup[]): Promise<{
  deletedSessions: number
  deletedTranscripts: number
}> {
  let deletedSessions = 0
  let deletedTranscripts = 0

  for (const group of groups) {
    const loserIds = group.losers.map((l) => l.id)

    if (isDryRun) {
      console.log(
        `[DRY-RUN] "${group.title}" (user: ${group.userId})` +
        ` | 보존: ${group.winner.id} (${group.winner.updated_at})` +
        ` | 삭제 대상: ${loserIds.length}건 [${loserIds.join(', ')}]`,
      )
      deletedSessions += loserIds.length
      continue
    }

    // transcripts 별도 삭제 (FK 없음, session_id가 PK)
    const { error: trErr, count: trCount } = await supabase
      .from('transcripts')
      .delete({ count: 'exact' })
      .in('session_id', loserIds)

    if (trErr) {
      console.error(`[ERROR] transcripts 삭제 실패 (${group.title}): ${trErr.message}`)
    } else {
      deletedTranscripts += trCount ?? 0
    }

    // sessions 삭제 — ON DELETE CASCADE로 7개 FK 테이블 자동 정리
    const { error: sessErr, count: sessCount } = await supabase
      .from('sessions')
      .delete({ count: 'exact' })
      .in('id', loserIds)

    if (sessErr) {
      console.error(`[ERROR] sessions 삭제 실패 (${group.title}): ${sessErr.message}`)
    } else {
      deletedSessions += sessCount ?? 0
    }
  }

  return { deletedSessions, deletedTranscripts }
}

// ── 메인 ───────────────────────────────────────────────────────────────

async function main() {
  console.log('════════════════════════════════════════════════════════════')
  console.log('  세션 중복 제거 스크립트')
  console.log(`  모드: ${isDryRun ? 'DRY-RUN (실제 삭제 안 함)' : 'LIVE (실제 삭제)'}`)
  console.log('  기준: user_id + title 중복 → 최신 updated_at 1건 보존')
  console.log('════════════════════════════════════════════════════════════\n')

  const groups = await findDuplicates()

  if (groups.length === 0) {
    console.log('[결과] 중복 세션 없음. 정리할 항목이 없습니다.')
    return
  }

  const totalLosers = groups.reduce((sum, g) => sum + g.losers.length, 0)
  console.log(`[발견] 중복 그룹: ${groups.length}개 | 삭제 대상 세션: ${totalLosers}건\n`)

  const { deletedSessions, deletedTranscripts } = await deleteLosers(groups)

  console.log('\n════════════════════════════════════════════════════════════')
  console.log('  결과 요약')
  console.log('════════════════════════════════════════════════════════════')
  console.log(`  중복 그룹:        ${groups.length}개`)
  console.log(`  삭제 세션:        ${deletedSessions}건 ${isDryRun ? '(예정)' : ''}`)
  console.log(`  삭제 transcripts: ${deletedTranscripts}건 ${isDryRun ? '(예정)' : ''}`)
  console.log(`  CASCADE 테이블:   score_components, labels, campaign_matches,`)
  console.log(`                    session_labels, billable_units, session_chunks,`)
  console.log(`                    transcript_chunks (자동 삭제)`)
  console.log('════════════════════════════════════════════════════════════')

  if (isDryRun) {
    console.log('\n  --dry-run 제거 후 다시 실행하면 실제 삭제됩니다.')
  }
}

main().catch((err) => {
  console.error('[FATAL]', err)
  process.exit(1)
})
