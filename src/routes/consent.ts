// ── Consent Invitation API Routes ──────────────────────────────────────
// 통화 상대방 동의 초대 영속화 (Option A 게이트 C+, 2026-04-29)
//
// localStorage는 클라이언트 캐시로만 활용하고, 본 라우트가 source of truth.
// 토큰 자체가 capability이므로 동의/거절/조회는 익명 허용 (토큰 검증으로 충분).
// 초대 생성/상태 변경(sent)은 인증 필요.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'

const consent = new Hono()

// ── 타입 ────────────────────────────────────────────────────────────────

type InvitationStatus =
  | 'pending'
  | 'sent'
  | 'opened'
  | 'agreed'
  | 'declined'
  | 'expired'

interface InvitationRow {
  id: string
  user_id: string | null
  session_id: string
  token: string
  status: InvitationStatus
  created_at: string
  sent_at: string | null
  responded_at: string | null
  expires_at: string | null
  ip_address: string | null
  user_agent: string | null
  share_method: 'web_share' | 'clipboard' | null
}

// ── 유틸 ────────────────────────────────────────────────────────────────

function clientIp(headerValue: string | undefined): string | null {
  if (!headerValue) return null
  const first = headerValue.split(',')[0]?.trim()
  return first && first.length > 0 ? first : null
}

function isExpired(row: Pick<InvitationRow, 'expires_at'>): boolean {
  if (!row.expires_at) return false // NULL = 무기한
  return new Date(row.expires_at).getTime() < Date.now()
}

// ── 라우트 ──────────────────────────────────────────────────────────────

/**
 * POST /api/consent/invitations
 * 초대 생성 또는 기존 활성 초대 반환 (멱등).
 *
 * Body: { sessionId, token, expiresAt? (ISO string | null) }
 *   - token은 클라이언트가 생성 (consentInvitation.ts generateToken)
 *   - expiresAt 미전달 시 NULL (무기한)
 */
consent.post('/invitations', authMiddleware, async (c) => {
  const userId = c.get('userId') as string
  const { sessionId, sessionIds, token, expiresAt } = getBody<{
    sessionId: string
    sessionIds?: string[]
    token: string
    expiresAt?: string | null
  }>(c)

  if (!sessionId || !token) {
    return c.json({ error: 'sessionId and token are required' }, 400)
  }

  // sessionIds 배열 정규화 — 빈 배열/누락 시 sessionId 단건으로 fallback
  const normalizedIds = Array.isArray(sessionIds) && sessionIds.length > 0
    ? sessionIds
    : [sessionId]

  // 기존 활성 초대 확인 (pending/sent/opened)
  const { data: existing } = await supabaseAdmin
    .from('consent_invitations')
    .select('*')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .in('status', ['pending', 'sent', 'opened'])
    .maybeSingle()

  if (existing && !isExpired(existing as InvitationRow)) {
    return c.json({ data: existing })
  }

  const { data: inserted, error } = await supabaseAdmin
    .from('consent_invitations')
    .insert({
      user_id: userId,
      session_id: sessionId,
      session_ids: normalizedIds,
      token,
      status: 'pending',
      expires_at: expiresAt ?? null,
    })
    .select('*')
    .single()

  if (error || !inserted) {
    console.error('[consent.invitations.insert] error:', error)
    return c.json({ error: 'Failed to create invitation' }, 500)
  }

  return c.json({ data: inserted })
})

/**
 * GET /api/consent/by-token/:token
 * 토큰으로 초대 조회 (PeerConsentPage 진입용).
 * 인증 불요 — 토큰 자체가 capability.
 */
consent.get('/by-token/:token', async (c) => {
  const token = c.req.param('token')
  if (!token) return c.json({ error: 'token is required' }, 400)

  const { data, error } = await supabaseAdmin
    .from('consent_invitations')
    .select('*')
    .eq('token', token)
    .maybeSingle()

  if (error) {
    console.error('[consent.by-token] error:', error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }

  if (!data) return c.json({ error: 'Invitation not found' }, 404)
  return c.json({ data })
})

/**
 * POST /api/consent/agree/:token
 * 상대방 동의 처리. IP 주소·User-Agent 자동 캡처 (감사 추적).
 * 인증 불요 — 토큰 자체가 capability.
 */
consent.post('/agree/:token', async (c) => {
  const token = c.req.param('token')
  if (!token) return c.json({ error: 'token is required' }, 400)

  const ip = clientIp(c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'))
  const userAgent = c.req.header('user-agent') ?? null

  // 현재 상태 조회
  const { data: row, error: selectErr } = await supabaseAdmin
    .from('consent_invitations')
    .select('*')
    .eq('token', token)
    .maybeSingle()

  if (selectErr) {
    console.error('[consent.agree.select] error:', selectErr)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
  if (!row) return c.json({ error: 'Invitation not found' }, 404)

  const invitation = row as InvitationRow

  if (isExpired(invitation)) {
    await supabaseAdmin
      .from('consent_invitations')
      .update({ status: 'expired' })
      .eq('id', invitation.id)
    return c.json({ error: '초대가 만료되었습니다' }, 410)
  }

  if (invitation.status === 'declined') {
    return c.json({ error: '이미 거절된 초대입니다' }, 409)
  }

  if (invitation.status === 'agreed') {
    // 멱등 — 이미 동의된 경우 그대로 반환
    return c.json({ data: invitation })
  }

  const now = new Date().toISOString()
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('consent_invitations')
    .update({
      status: 'agreed',
      responded_at: now,
      ip_address: ip,
      user_agent: userAgent,
    })
    .eq('id', invitation.id)
    .select('*')
    .single()

  if (updateErr || !updated) {
    console.error('[consent.agree.update] error:', updateErr)
    return c.json({ error: 'Failed to record agreement' }, 500)
  }

  // ── sessions 일괄 promote (Bug C/D fix) ──────────────────────────
  // peer가 동의한 시점 = 양측 합의 완료. invitation에 묶인 모든 sessions를
  // user_only → both_agreed로 승격. session_ids가 비어있으면 단건 session_id로 fallback.
  // user_only인 sessions만 갱신해서 이전에 철회된 locked 상태는 건드리지 않는다.
  const sessionIds = Array.isArray((invitation as any).session_ids) && (invitation as any).session_ids.length > 0
    ? (invitation as any).session_ids as string[]
    : invitation.session_id
      ? [invitation.session_id]
      : []

  if (sessionIds.length > 0) {
    const { error: promoteErr, count } = await supabaseAdmin
      .from('sessions')
      .update({ consent_status: 'both_agreed', consented_at: now }, { count: 'exact' })
      .in('id', sessionIds)
      .eq('user_id', invitation.user_id)
      .eq('consent_status', 'user_only')
    if (promoteErr) {
      console.error('[consent.agree.promote-sessions] error:', promoteErr)
      // invitation은 이미 'agreed' 처리됨 — sessions 갱신 실패는 별도 모니터링
      // 사용자 측 polling에서 재시도 가능 (idempotent)
    } else {
      console.log(`[consent.agree.promote-sessions] ${count}/${sessionIds.length} promoted`)
    }
  }

  return c.json({ data: updated })
})

/**
 * POST /api/consent/decline/:token
 * 상대방 거절 처리.
 */
consent.post('/decline/:token', async (c) => {
  const token = c.req.param('token')
  if (!token) return c.json({ error: 'token is required' }, 400)

  const { data: row } = await supabaseAdmin
    .from('consent_invitations')
    .select('*')
    .eq('token', token)
    .maybeSingle()

  if (!row) return c.json({ error: 'Invitation not found' }, 404)
  const invitation = row as InvitationRow

  if (invitation.status === 'agreed' || invitation.status === 'declined') {
    return c.json({ data: invitation })
  }

  const { data: updated, error } = await supabaseAdmin
    .from('consent_invitations')
    .update({
      status: 'declined',
      responded_at: new Date().toISOString(),
    })
    .eq('id', invitation.id)
    .select('*')
    .single()

  if (error) {
    console.error('[consent.decline.update] error:', error)
    return c.json({ error: 'Failed to record decline' }, 500)
  }

  return c.json({ data: updated })
})

/**
 * PATCH /api/consent/invitations/:id/status
 * sent / opened 상태 update (소유자만).
 * Body: { status: 'sent' | 'opened', shareMethod?: 'web_share' | 'clipboard' }
 */
consent.patch('/invitations/:id/status', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const userId = c.get('userId') as string
  const { status, shareMethod } = getBody<{
    status: 'sent' | 'opened'
    shareMethod?: 'web_share' | 'clipboard'
  }>(c)

  if (!id) return c.json({ error: 'id is required' }, 400)
  if (status !== 'sent' && status !== 'opened') {
    return c.json({ error: 'status must be sent or opened' }, 400)
  }

  const update: Record<string, unknown> = { status }
  if (status === 'sent') update.sent_at = new Date().toISOString()
  if (shareMethod) update.share_method = shareMethod

  const { data, error } = await supabaseAdmin
    .from('consent_invitations')
    .update(update)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle()

  if (error) {
    console.error('[consent.status.update] error:', error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
  if (!data) return c.json({ error: 'Invitation not found' }, 404)
  return c.json({ data })
})

/**
 * GET /api/consent/by-session/:sessionId
 * 세션의 초대 목록 조회 (소유자만).
 */
consent.get('/by-session/:sessionId', authMiddleware, async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('sessionId')

  const { data, error } = await supabaseAdmin
    .from('consent_invitations')
    .select('*')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[consent.by-session] error:', error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
  return c.json({ data: data ?? [] })
})

/**
 * GET /api/consent/mine
 * 본인 모든 초대 조회 (앱 부팅 시 localStorage 동기화용).
 */
consent.get('/mine', authMiddleware, async (c) => {
  const userId = c.get('userId') as string

  const { data, error } = await supabaseAdmin
    .from('consent_invitations')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[consent.mine] error:', error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
  return c.json({ data: data ?? [] })
})

// ── 동의 철회 4단계 처리 (법무 컨설팅 2026-04-04 기반) ───────────────────────

/**
 * GET /api/consent/delivered-sessions
 * 이미 제3자에게 제공된 세션·구매자 목록 (동의 철회 시 사용자 안내용).
 *
 * 응답: [{ sessionId, clientId, clientName, deliveredAt }]
 * 사용자가 직접 해당 구매자에게 삭제 요청해야 함을 안내하기 위함.
 */
consent.get('/delivered-sessions', authMiddleware, async (c) => {
  const userId = c.get('userId') as string

  const { data: items, error } = await supabaseAdmin
    .from('export_package_items')
    .select('session_id, export_request_id')
    .eq('user_id', userId)
    .not('session_id', 'is', null)

  if (error) {
    console.error('[consent.delivered-sessions] items error:', error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }

  if (!items || items.length === 0) {
    return c.json({ data: [] })
  }

  const exportIds = Array.from(new Set(items.map((i) => i.export_request_id).filter(Boolean)))

  // delivered 상태인 export_jobs만 매칭
  const { data: jobs, error: jobsErr } = await supabaseAdmin
    .from('export_jobs')
    .select('id, status')
    .in('id', exportIds)

  if (jobsErr) {
    console.error('[consent.delivered-sessions] jobs error:', jobsErr)
    return c.json({ error: 'Internal Server Error' }, 500)
  }

  const deliveredJobIds = new Set(
    (jobs ?? []).filter((j) => j.status === 'delivered').map((j) => j.id),
  )

  if (deliveredJobIds.size === 0) {
    return c.json({ data: [] })
  }

  // delivery_records로 client 매칭
  const { data: deliveries, error: delErr } = await supabaseAdmin
    .from('delivery_records')
    .select('export_job_id, client_id, delivered_at')
    .in('export_job_id', Array.from(deliveredJobIds))

  if (delErr) {
    console.error('[consent.delivered-sessions] delivery error:', delErr)
    return c.json({ error: 'Internal Server Error' }, 500)
  }

  const deliveryByJob = new Map(
    (deliveries ?? []).map((d) => [d.export_job_id, d]),
  )

  const result = items
    .filter((i) => i.export_request_id && deliveredJobIds.has(i.export_request_id))
    .map((i) => {
      const delivery = deliveryByJob.get(i.export_request_id)
      return {
        sessionId: i.session_id,
        clientId: delivery?.client_id ?? null,
        deliveredAt: delivery?.delivered_at ?? null,
      }
    })

  return c.json({ data: result })
})

/**
 * POST /api/consent/withdraw
 * 동의 철회 통합 처리 (4단계).
 *
 * Body: { reason?: string }
 *
 * 처리 단계:
 *   1. consent_withdrawals 감사 로그 기록
 *   2. cancelPendingDeliveries: 사용자가 포함된 export_package_items에서
 *      아직 delivered되지 않은 항목 수 카운트 (실제 cancel은 admin 수동 검토)
 *   3. (S3 파일 삭제는 별도 DELETE /api/storage/user 호출 — 기존 라우트 활용)
 *   4. anonymizeUserData: PIPA 동의 철회 표시 + sessions.consent_status='locked' 일괄 적용
 *   5. delivered_sessions JSON 응답 (사용자 안내용)
 *
 * 처리 시한: PIPA 시행령 43조 5일 이내 (본 API 호출은 즉시, S3 삭제는 별도 트리거).
 */
consent.post('/withdraw', authMiddleware, async (c) => {
  const userId = c.get('userId') as string
  const { reason } = getBody<{ reason?: string }>(c)

  // 1. 감사 로그 기록 (먼저 생성하여 처리 추적)
  const { data: withdrawal, error: withdrawalErr } = await supabaseAdmin
    .from('consent_withdrawals')
    .insert({
      user_id: userId,
      reason: reason ?? null,
    })
    .select('id')
    .single()

  if (withdrawalErr || !withdrawal) {
    console.error('[consent.withdraw] insert error:', withdrawalErr)
    return c.json({ error: 'Failed to record withdrawal' }, 500)
  }

  const withdrawalId = withdrawal.id

  // 2. cancelPendingDeliveries — 미납품 항목 수 카운트
  // export_package_items에서 사용자 항목 중 export_jobs.status가 'delivered'가 아닌 것
  let cancelledCount = 0
  try {
    const { data: userItems } = await supabaseAdmin
      .from('export_package_items')
      .select('export_request_id')
      .eq('user_id', userId)

    if (userItems && userItems.length > 0) {
      const jobIds = Array.from(
        new Set(userItems.map((i) => i.export_request_id).filter(Boolean)),
      )
      const { data: jobs } = await supabaseAdmin
        .from('export_jobs')
        .select('id, status')
        .in('id', jobIds)

      cancelledCount = userItems.filter((item) => {
        const job = jobs?.find((j) => j.id === item.export_request_id)
        return job && job.status !== 'delivered'
      }).length
    }
  } catch (err) {
    console.error('[consent.withdraw] count pending error:', err)
  }

  // 3. anonymizeUserData — sessions.consent_status='locked' 일괄 적용
  let anonymizedAt: string | null = null
  try {
    const { error: anonErr } = await supabaseAdmin
      .from('sessions')
      .update({
        consent_status: 'locked',
        visibility_status: 'PRIVATE',
        is_public: false,
      })
      .eq('user_id', userId)

    if (!anonErr) {
      anonymizedAt = new Date().toISOString()
    } else {
      console.error('[consent.withdraw] anonymize error:', anonErr)
    }
  } catch (err) {
    console.error('[consent.withdraw] anonymize exception:', err)
  }

  // 4. PIPA 동의 철회 표시 (user_consents 또는 user_settings)
  try {
    await supabaseAdmin
      .from('user_consents')
      .update({
        consent_withdrawn: true,
        consent_withdrawn_updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
  } catch (err) {
    console.error('[consent.withdraw] pipa update error (non-fatal):', err)
  }

  // 5. delivered sessions list 수집
  const deliveredSessions: Array<{
    sessionId: string
    clientId: string | null
    deliveredAt: string | null
  }> = []

  try {
    const { data: items } = await supabaseAdmin
      .from('export_package_items')
      .select('session_id, export_request_id')
      .eq('user_id', userId)
      .not('session_id', 'is', null)

    if (items && items.length > 0) {
      const jobIds = Array.from(
        new Set(items.map((i) => i.export_request_id).filter(Boolean)),
      )
      const { data: jobs } = await supabaseAdmin
        .from('export_jobs')
        .select('id, status')
        .in('id', jobIds)

      const deliveredJobIds = new Set(
        (jobs ?? []).filter((j) => j.status === 'delivered').map((j) => j.id),
      )

      const { data: deliveries } = await supabaseAdmin
        .from('delivery_records')
        .select('export_job_id, client_id, delivered_at')
        .in('export_job_id', Array.from(deliveredJobIds))

      const deliveryByJob = new Map(
        (deliveries ?? []).map((d) => [d.export_job_id, d]),
      )

      items
        .filter((i) => i.export_request_id && deliveredJobIds.has(i.export_request_id))
        .forEach((i) => {
          const delivery = deliveryByJob.get(i.export_request_id)
          deliveredSessions.push({
            sessionId: i.session_id as string,
            clientId: (delivery?.client_id as string | undefined) ?? null,
            deliveredAt: (delivery?.delivered_at as string | undefined) ?? null,
          })
        })
    }
  } catch (err) {
    console.error('[consent.withdraw] delivered query error:', err)
  }

  // 6. 감사 로그 업데이트 (4단계 처리 결과 기록)
  await supabaseAdmin
    .from('consent_withdrawals')
    .update({
      cancelled_pending_count: cancelledCount,
      anonymized_at: anonymizedAt,
      delivered_sessions: deliveredSessions,
      completed_at: new Date().toISOString(),
    })
    .eq('id', withdrawalId)

  return c.json({
    data: {
      withdrawalId,
      cancelledPendingCount: cancelledCount,
      anonymizedAt,
      deliveredSessions,
      message:
        '동의 철회가 처리되었습니다. 회사 보유 데이터는 5일 이내 삭제됩니다. 이미 제3자에게 제공된 데이터는 해당 구매자에게 직접 삭제 요청이 필요합니다.',
    },
  })
})

// ── BM v10.0 — DEV 토글 시뮬레이션 (plan v10.6 수정 1·2) ──────────────
// 본 endpoint는 DEV/local 빌드 클라이언트에서만 호출. live 빌드는 카카오톡 등 외부 동의 path 사용.

/**
 * POST /api/consent/dev-test/promote
 * DEV 토글로 양자 동의 시뮬레이션 → consent_invitations.status='agreed' + sessions consent_status='both_agreed'
 * is_test_mode 데이터 격리 marker (DB 측 packageBuilder 제외).
 */
consent.post('/dev-test/promote', authMiddleware, async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: 'unauthenticated' }, 401)
  const body = getBody<{ session_ids: string[]; peer_label?: string }>(c)
  if (!Array.isArray(body?.session_ids) || body.session_ids.length === 0) {
    return c.json({ error: 'session_ids required' }, 400)
  }

  // sessions consent_status 일괄 both_agreed 승격
  const { error: sErr } = await supabaseAdmin
    .from('sessions')
    .update({ consent_status: 'both_agreed', consented_at: new Date().toISOString() })
    .in('id', body.session_ids)
    .eq('user_id', userId)
  if (sErr) {
    return c.json({ error: `sessions update failed: ${sErr.message}` }, 500)
  }

  // consent_invitations에 manual_dev_test marker 기록 (감사 추적)
  // 스키마: token, status, consent_method, session_id, user_id, expires_at, created_at
  // (consented_at/agreed_at 컬럼은 존재 X — created_at으로 시각 기록)
  const now = new Date().toISOString()
  const invitations = body.session_ids.map((sid) => ({
    user_id: userId,
    session_id: sid,
    token: `dev-test-${sid}-${Date.now()}`,
    consent_method: 'manual_dev_test' as const,
    status: 'agreed' as const,
    expires_at: null,
    created_at: now,
  }))
  const { error: iErr } = await supabaseAdmin.from('consent_invitations').insert(invitations)
  if (iErr) {
    // 이미 invitation이 있으면 skip 가능 (best effort)
    console.warn('[consent.dev-test.promote] invitation insert skipped:', iErr.message)
  }

  return c.json({
    data: {
      promoted: body.session_ids.length,
      promoted_at: now,
      consent_method: 'manual_dev_test',
    },
  })
})

/**
 * POST /api/consent/rollback/stage1
 * 0~30s 내 — 큐 취소. consent_status='locked' 복귀, consent_invitations.status='pending'.
 */
consent.post('/rollback/stage1', authMiddleware, async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: 'unauthenticated' }, 401)
  const body = getBody<{ session_ids: string[] }>(c)
  if (!Array.isArray(body?.session_ids)) {
    return c.json({ error: 'session_ids required' }, 400)
  }

  await supabaseAdmin
    .from('sessions')
    .update({ consent_status: 'locked' })
    .in('id', body.session_ids)
    .eq('user_id', userId)

  await supabaseAdmin
    .from('consent_invitations')
    .update({ status: 'pending' })
    .in('session_id', body.session_ids)
    .eq('user_id', userId)
    .eq('consent_method', 'manual_dev_test')

  return c.json({ data: { stage: 1, action: 'cancelled', sessions: body.session_ids.length } })
})

/**
 * POST /api/consent/rollback/stage2
 * 30s~5min — 업로드 abort + cleanup. consent_invitations.status='cancelled'.
 * 실제 업로드 abort는 클라이언트 측 AbortController + storageUpload 측에서 처리.
 */
consent.post('/rollback/stage2', authMiddleware, async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: 'unauthenticated' }, 401)
  const body = getBody<{ session_ids: string[] }>(c)
  if (!Array.isArray(body?.session_ids)) {
    return c.json({ error: 'session_ids required' }, 400)
  }

  await supabaseAdmin
    .from('sessions')
    .update({ consent_status: 'locked' })
    .in('id', body.session_ids)
    .eq('user_id', userId)

  await supabaseAdmin
    .from('consent_invitations')
    .update({ status: 'cancelled' })
    .in('session_id', body.session_ids)
    .eq('user_id', userId)
    .eq('consent_method', 'manual_dev_test')

  return c.json({ data: { stage: 2, action: 'aborted', sessions: body.session_ids.length } })
})

export default consent
