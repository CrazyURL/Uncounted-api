// ── Packaging Worker ─────────────────────────────────────────────────
// delivery_packages 생성 워커 — 1시간(3600초) 단위 패키지 자동 묶음
//
// 흐름:
//   1. consent=both_agreed + stt=done + 미패키징 세션 조회
//   2. 탐욕적 그룹화: duration 합계가 TARGET_SECONDS 초과 직전까지 묶음
//      마지막 미완성 그룹은 보류 (TARGET_SECONDS 채울 때까지 대기)
//   3. delivery_packages INSERT (status='building')
//   4. sessions.in_package_id 연결
//   5. export-builder.buildDeliveryPackageZip() → S3 ZIP 생성
//   6. delivery_packages UPDATE (status='complete', size_bytes)
//   실패 시 delivery_packages.status → 'pending' (재시도 가능 상태)
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from '../lib/supabase.js'

const TARGET_SECONDS = 3_600

interface EligibleSession {
  id: string
  duration: number
  consented_at: string | null
  utterance_count: number
}

export async function runPackagingBatch(): Promise<void> {
  // 이미 building 중인 패키지가 있으면 중복 실행 방지
  const { data: building } = await supabaseAdmin
    .from('delivery_packages')
    .select('id')
    .eq('status', 'building')
    .limit(1)

  if (building && building.length > 0) {
    console.log('[packaging-worker] already building — skip')
    return
  }

  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('id, duration, consented_at, utterance_count')
    .eq('consent_status', 'both_agreed')
    .eq('stt_status', 'done')
    .is('in_package_id', null)
    .order('consented_at', { ascending: true, nullsFirst: false })

  if (error) throw new Error(`[packaging-worker] sessions query: ${error.message}`)

  const eligible = (data ?? []) as EligibleSession[]
  if (eligible.length === 0) {
    console.log('[packaging-worker] no eligible sessions')
    return
  }

  const groups = greedyGroup(eligible)

  if (groups.length === 0) {
    const totalSec = eligible.reduce((s, r) => s + r.duration, 0)
    console.log(
      `[packaging-worker] ${eligible.length} sessions pending (${totalSec}s total) — ` +
      `insufficient for a full ${TARGET_SECONDS}s package`,
    )
    return
  }

  console.log(`[packaging-worker] creating ${groups.length} package(s) from ${eligible.length} eligible sessions`)

  for (const group of groups) {
    await processGroup(group)
  }
}

// 탐욕적 그룹화: 현재 그룹에 세션을 추가하면 TARGET_SECONDS 초과 시 새 그룹 시작.
// 마지막 미완성 그룹(아직 TARGET_SECONDS 미달)은 반환하지 않음.
function greedyGroup(sessions: EligibleSession[]): EligibleSession[][] {
  const groups: EligibleSession[][] = []
  let current: EligibleSession[] = []
  let accumulated = 0

  for (const s of sessions) {
    if (current.length > 0 && accumulated + s.duration > TARGET_SECONDS) {
      groups.push(current)
      current = [s]
      accumulated = s.duration
    } else {
      current.push(s)
      accumulated += s.duration
    }
  }
  // current(마지막 그룹)는 TARGET_SECONDS 미달이므로 보류

  return groups
}

async function processGroup(sessions: EligibleSession[]): Promise<void> {
  const totalDuration = sessions.reduce((s, r) => s + r.duration, 0)
  const totalUtterances = sessions.reduce((s, r) => s + (r.utterance_count ?? 0), 0)
  const packageNumber = await generatePackageNumber()
  const filename = `${packageNumber}.zip`
  const storagePath = `exports/${filename}`

  const { data: pkg, error: insertError } = await supabaseAdmin
    .from('delivery_packages')
    .insert({
      package_number: packageNumber,
      filename,
      storage_path: storagePath,
      status: 'building',
      duration_seconds: totalDuration,
      duration_minutes: Math.round(totalDuration / 60),
      billable_hours: Math.ceil(totalDuration / 3_600),
      session_count: sessions.length,
      utterance_count: totalUtterances,
    })
    .select('id')
    .single()

  if (insertError || !pkg) {
    throw new Error(`[packaging-worker] insert delivery_package: ${insertError?.message}`)
  }

  const packageId = (pkg as { id: string }).id
  const sessionIds = sessions.map(s => s.id)

  const { error: linkError } = await supabaseAdmin
    .from('sessions')
    .update({ in_package_id: packageId, packaged_at: new Date().toISOString() })
    .in('id', sessionIds)

  if (linkError) {
    console.error(`[packaging-worker] link sessions failed: ${linkError.message}`)
    await supabaseAdmin
      .from('delivery_packages')
      .update({ status: 'pending' })
      .eq('id', packageId)
    return
  }

  try {
    const { buildDeliveryPackageZip } = await import('./export-builder.js')
    const { sizeBytes } = await buildDeliveryPackageZip(packageId)

    await supabaseAdmin
      .from('delivery_packages')
      .update({
        status: 'complete',
        completed_at: new Date().toISOString(),
        size_bytes: sizeBytes,
      })
      .eq('id', packageId)

    console.log(
      `[packaging-worker] ${packageNumber} done` +
      ` — ${sessions.length} sessions, ${totalDuration}s, ${sizeBytes} bytes`,
    )
  } catch (err) {
    console.error(`[packaging-worker] zip failed for ${packageId}:`, err)
    await supabaseAdmin
      .from('delivery_packages')
      .update({ status: 'pending' })
      .eq('id', packageId)
  }
}

// PKG-YYYYMMDD-NNN 형식. 당일 패키지 수(0-based) + 1 로 시퀀스 부여.
async function generatePackageNumber(): Promise<string> {
  const now = new Date()
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '')
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
  const dayEnd = `${now.toISOString().slice(0, 10)}T23:59:59.999Z`

  const { count } = await supabaseAdmin
    .from('delivery_packages')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', dayStart)
    .lte('created_at', dayEnd)

  const seq = String((count ?? 0) + 1).padStart(3, '0')
  return `PKG-${yyyymmdd}-${seq}`
}
