// ── Call-level Ownership API Routes (049 v5) ───────────────────────────
// 통화 단위 unique entity 등록 + 후보 매칭 + ambiguity check + 권리자 박음.
//
// 처리 분기 (Plan v5 §API):
//   no_match    → 새 call + contract(pending) + participants(uploader, agreed)
//   matched(sold)   → 409 already_sold (claim_eligible 안내)
//   matched(unsold) → participants UPSERT(consenter, agreed) + sessions.call_id
//   ambiguous   → 새 call 등록 + ambiguous_matches 로그
//
// 참고: 약관 v1.1 제18조 — 1 통화 = 1회 판매. 탈퇴·재가입 시에도 동일.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'
import {
  classifyGrade,
  classifyPhone,
  findExistingCall,
  generateFingerprintParts,
  normalizePhone,
  type CallGrade,
} from '../lib/callFingerprint.js'

const calls = new Hono()

// ── 타입 ────────────────────────────────────────────────────────────────

interface UploadBody {
  caller_phone: string
  callee_phone: string
  started_at: string // ISO 8601
  duration: number   // seconds
  audio_url?: string
  session_id?: string
}

interface UploadResult {
  status: 'created' | 'matched' | 'already_sold' | 'ambiguous' | 'excluded'
  call_id?: string
  contract_id?: string
  grade?: CallGrade
  reason?: string
  claim_eligible?: boolean
}

// ── 유틸 ────────────────────────────────────────────────────────────────

function clientIp(headerValue: string | undefined): string | null {
  if (!headerValue) return null
  const first = headerValue.split(',')[0]?.trim()
  return first && first.length > 0 ? first : null
}

async function hashPhoneForParticipant(phone: string): Promise<string> {
  const { createHmac } = await import('node:crypto')
  const secret = process.env.PHONE_HASH_SECRET
  if (!secret) throw new Error('PHONE_HASH_SECRET not configured')
  return createHmac('sha256', secret).update(normalizePhone(phone)).digest('hex')
}

// ── POST /api/calls/upload ──────────────────────────────────────────────

calls.post('/upload', authMiddleware, async (c) => {
  const userId = c.get('userId') as string
  const body = getBody<UploadBody>(c)
  const ip = clientIp(c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'))
  const userAgent = c.req.header('user-agent') ?? null

  if (!body.caller_phone || !body.callee_phone || !body.started_at || body.duration == null) {
    return c.json({ error: 'caller_phone, callee_phone, started_at, duration required' }, 400)
  }

  // 1. 정규화 + 분류
  const callerNormalized = normalizePhone(body.caller_phone)
  const calleeNormalized = normalizePhone(body.callee_phone)
  const callerType = classifyPhone(body.caller_phone)
  const calleeType = classifyPhone(body.callee_phone)
  const grade = classifyGrade(callerType, calleeType)

  // 2. EXCLUDED → DB 등록 X
  if (grade === 'excluded') {
    return c.json<UploadResult>({
      status: 'excluded',
      grade,
      reason: '거래 불가 통화 (양쪽 비개인 또는 식별 불가). 약관 v1.1 제2조.',
    })
  }

  const startedAt = new Date(body.started_at)
  const callRecord = {
    callerPhone: body.caller_phone,
    calleePhone: body.callee_phone,
    startedAt,
    duration: body.duration,
  }
  const fp = generateFingerprintParts(callRecord)

  // 3. 후보 조회 + ambiguity check
  const matchResult = await findExistingCall(supabaseAdmin, callRecord)

  // 4-a. matched + sold → 409
  if (matchResult.type === 'matched' && matchResult.call.sold_at) {
    return c.json<UploadResult>(
      {
        status: 'already_sold',
        call_id: matchResult.call.call_id,
        grade,
        claim_eligible: true,
        reason: '이미 매수자에게 판매된 통화입니다. 권리 주장 시 별도 절차로 진행됩니다.',
      },
      409,
    )
  }

  // 4-b. matched + unsold → participants UPSERT (consenter agreed)
  if (matchResult.type === 'matched') {
    const callId = matchResult.call.call_id
    const phoneHash = await hashPhoneForParticipant(body.caller_phone)

    // 기존 contract 조회
    const { data: contract } = await supabaseAdmin
      .from('contracts')
      .select('contract_id, status')
      .eq('call_id', callId)
      .maybeSingle()

    if (!contract) {
      console.error('[calls.upload] matched call without contract:', callId)
      return c.json({ error: 'Internal: matched call missing contract' }, 500)
    }

    // participants UPSERT
    const { error: upsertErr } = await supabaseAdmin
      .from('participants')
      .upsert(
        {
          contract_id: contract.contract_id,
          phone_hash: phoneHash,
          user_id: userId,
          consent_status: 'agreed',
          consent_agreed_at: new Date().toISOString(),
          consent_ip: ip,
          consent_user_agent: userAgent,
          consent_terms_version: 'v1.1',
        },
        { onConflict: 'contract_id,phone_hash' },
      )

    if (upsertErr) {
      console.error('[calls.upload.participants_upsert] error:', upsertErr)
      return c.json({ error: 'Failed to upsert participant' }, 500)
    }

    // sessions.call_id 매핑 (있으면)
    if (body.session_id) {
      await supabaseAdmin
        .from('sessions')
        .update({ call_id: callId })
        .eq('id', body.session_id)
        .eq('user_id', userId)
    }

    return c.json<UploadResult>({
      status: 'matched',
      call_id: callId,
      contract_id: contract.contract_id,
      grade,
    })
  }

  // 4-c/d. no_match 또는 ambiguous → 새 call 등록
  const { data: insertedCall, error: callErr } = await supabaseAdmin
    .from('calls')
    .insert({
      fingerprint: fp.fingerprint,
      started_at: startedAt.toISOString(),
      started_at_minute_bucket: fp.minuteBucket,
      started_at_quartile: fp.quartile,
      duration_seconds: body.duration,
      duration_bucket: fp.durationBucket,
      speakers_hash: fp.speakersHash,
      caller_phone_normalized: callerNormalized,
      callee_phone_normalized: calleeNormalized,
      caller_type: callerType,
      callee_type: calleeType,
      grade,
      status: 'pending',
    })
    .select('call_id')
    .single()

  if (callErr || !insertedCall) {
    console.error('[calls.upload.insert_call] error:', callErr)
    return c.json({ error: 'Failed to insert call' }, 500)
  }

  const newCallId = insertedCall.call_id as string

  // contract 생성 (pending)
  const { data: insertedContract, error: contractErr } = await supabaseAdmin
    .from('contracts')
    .insert({
      call_id: newCallId,
      terms_version: 'v1.1',
      status: 'pending',
    })
    .select('contract_id')
    .single()

  if (contractErr || !insertedContract) {
    console.error('[calls.upload.insert_contract] error:', contractErr)
    return c.json({ error: 'Failed to insert contract' }, 500)
  }

  const contractId = insertedContract.contract_id as string

  // uploader는 자동 동의 (본인 권리)
  const callerHash = await hashPhoneForParticipant(body.caller_phone)
  const calleeHash = await hashPhoneForParticipant(body.callee_phone)

  // STANDARD 등급은 개인 측 100% 권리. 100/0으로 박음.
  const isStandard = grade === 'standard'
  const personalSide: 'caller' | 'callee' =
    callerType === 'mobile' || callerType === 'landline' ? 'caller' : 'callee'

  const participantsRows = [
    {
      contract_id: contractId,
      phone_hash: callerHash,
      user_id: userId,
      consent_status: 'agreed',
      consent_agreed_at: new Date().toISOString(),
      consent_ip: ip,
      consent_user_agent: userAgent,
      consent_terms_version: 'v1.1',
      revenue_share: isStandard && personalSide === 'caller' ? 100.0 : isStandard ? 0.0 : 50.0,
      revenue_share_basis: isStandard ? 'sole' : 'standard',
    },
    {
      contract_id: contractId,
      phone_hash: calleeHash,
      user_id: null, // 상대방 미가입자
      consent_status: 'pending',
      revenue_share: isStandard && personalSide === 'callee' ? 100.0 : isStandard ? 0.0 : 50.0,
      revenue_share_basis: isStandard ? 'sole' : 'standard',
    },
  ]

  const { error: pErr } = await supabaseAdmin.from('participants').insert(participantsRows)
  if (pErr) {
    console.error('[calls.upload.insert_participants] error:', pErr)
    return c.json({ error: 'Failed to insert participants' }, 500)
  }

  // ambiguous인 경우 audit log
  if (matchResult.type === 'ambiguous') {
    await supabaseAdmin.from('ambiguous_matches').insert({
      new_call_id: newCallId,
      candidate_call_ids: matchResult.candidates.map((c) => c.call_id),
      ambiguity_ratio: parseFloat(matchResult.reason.match(/ratio ([\d.]+)/)?.[1] ?? '0'),
      reason: matchResult.reason,
      flagged_for_review: true,
    })
  }

  // sessions.call_id 매핑
  if (body.session_id) {
    await supabaseAdmin
      .from('sessions')
      .update({ call_id: newCallId })
      .eq('id', body.session_id)
      .eq('user_id', userId)
  }

  return c.json<UploadResult>({
    status: matchResult.type === 'ambiguous' ? 'ambiguous' : 'created',
    call_id: newCallId,
    contract_id: contractId,
    grade,
    reason: matchResult.type === 'ambiguous' ? matchResult.reason : undefined,
  })
})

export default calls
