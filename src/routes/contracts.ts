// ── Contract Agreement API Routes (049 v5) ─────────────────────────────
// 받는 사람의 동의 처리. 모든 participants가 agreed가 되면 contract.status='agreed' +
// call.status='sellable'로 박음.
//
// 인증 불요 — token이 capability. token으로 contract_id + phone_hash 식별.
// terms_version은 동의 시점 약관 버전 박음 (법무 증빙).

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { getBody } from '../lib/middleware.js'

const contracts = new Hono()

interface AgreeBody {
  token?: string
  contract_id?: string
  phone_hash: string
  terms_version: string
}

function clientIp(headerValue: string | undefined): string | null {
  if (!headerValue) return null
  const first = headerValue.split(',')[0]?.trim()
  return first && first.length > 0 ? first : null
}

// ── POST /api/contracts/agree ───────────────────────────────────────────

contracts.post('/agree', async (c) => {
  const body = getBody<AgreeBody>(c)
  const ip = clientIp(c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'))
  const userAgent = c.req.header('user-agent') ?? null

  if (!body.phone_hash || !body.terms_version) {
    return c.json({ error: 'phone_hash and terms_version are required' }, 400)
  }

  // contract_id 식별 — token 또는 직접 contract_id
  let contractId: string | null = body.contract_id ?? null

  if (!contractId && body.token) {
    // token → consent_invitations → contract_id 매핑 (peer_id 또는 session_id 경로)
    // 시드 단계는 contract_id 직접 받는 케이스 우선.
    const { data: invitation } = await supabaseAdmin
      .from('consent_invitations')
      .select('id, session_id, peer_id')
      .eq('token', body.token)
      .maybeSingle()

    if (!invitation) {
      return c.json({ error: 'Invitation not found' }, 404)
    }

    // session_id로 sessions.call_id → contracts.call_id 역추적
    if (invitation.session_id) {
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('call_id')
        .eq('id', invitation.session_id)
        .maybeSingle()

      if (session?.call_id) {
        const { data: contract } = await supabaseAdmin
          .from('contracts')
          .select('contract_id')
          .eq('call_id', session.call_id)
          .maybeSingle()

        contractId = contract?.contract_id ?? null
      }
    }
  }

  if (!contractId) {
    return c.json({ error: 'contract_id 식별 실패 (token 무효 또는 call 미매핑)' }, 404)
  }

  // participants 업데이트
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('participants')
    .update({
      consent_status: 'agreed',
      consent_agreed_at: new Date().toISOString(),
      consent_ip: ip,
      consent_user_agent: userAgent,
      consent_terms_version: body.terms_version,
    })
    .eq('contract_id', contractId)
    .eq('phone_hash', body.phone_hash)
    .select('contract_id, phone_hash, consent_status')
    .single()

  if (updateErr || !updated) {
    console.error('[contracts.agree.update] error:', updateErr)
    return c.json({ error: 'participant 미존재 또는 업데이트 실패' }, 404)
  }

  // 모든 participants가 agreed인지 확인
  const { data: allParticipants } = await supabaseAdmin
    .from('participants')
    .select('consent_status')
    .eq('contract_id', contractId)

  const allAgreed = allParticipants?.every((p) => p.consent_status === 'agreed') ?? false

  if (allAgreed) {
    // contract.status = 'agreed' + call.status = 'sellable'
    const { data: contract } = await supabaseAdmin
      .from('contracts')
      .update({ status: 'agreed', agreed_at: new Date().toISOString() })
      .eq('contract_id', contractId)
      .select('call_id')
      .single()

    if (contract?.call_id) {
      await supabaseAdmin
        .from('calls')
        .update({ status: 'sellable' })
        .eq('call_id', contract.call_id)
    }
  }

  return c.json({
    data: {
      contract_id: contractId,
      phone_hash: body.phone_hash,
      consent_status: 'agreed',
      contract_status: allAgreed ? 'agreed' : 'pending',
      call_status: allAgreed ? 'sellable' : 'pending',
    },
  })
})

export default contracts
