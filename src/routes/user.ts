// ── User API Routes ─────────────────────────────────────────────────────
// 사용자 프로필 관련 엔드포인트

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'

const user = new Hono()

user.use('/*', authMiddleware)

// ── 동의 상태 기본값 ─────────────────────────────────────────────────────

const DEFAULT_CONSENT = {
  collect_consent: false,
  collect_consent_updated_at: null,
  third_party_consent: false,
  third_party_consent_updated_at: null,
  consent_withdrawn: false,
  consent_withdrawn_updated_at: null,
  withdrawal_notified_at: null,
  sku_consents: {} as Record<string, boolean>,
}

// ── GET /api/user/consent ────────────────────────────────────────────────
// 현재 동의 상태 조회. 행 없으면 기본값(모두 false) 반환.

user.get('/consent', async (c) => {
  const userId = c.get('userId') as string

  const { data, error } = await supabaseAdmin
    .from('users_profile')
    .select('collect_consent, collect_consent_updated_at, third_party_consent, third_party_consent_updated_at, consent_withdrawn, consent_withdrawn_updated_at, withdrawal_notified_at, sku_consents')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[user/consent GET] DB error:', error)
    return c.json({ error: 'DB error' }, 500)
  }

  return c.json({ data: data ?? DEFAULT_CONSENT })
})

// ── PUT /api/user/consent ────────────────────────────────────────────────
// 동의 상태 저장. 기존 DB 값과 merge하여 partial 업데이트 지원.
// 행 없으면 INSERT(pid=userId), 있으면 UPDATE.

user.put('/consent', async (c) => {
  const userId = c.get('userId') as string
  const body = getBody(c) as {
    collect_consent?: boolean
    collect_consent_updated_at?: string | null
    third_party_consent?: boolean
    third_party_consent_updated_at?: string | null
    consent_withdrawn?: boolean
    consent_withdrawn_updated_at?: string | null
    withdrawal_notified_at?: string | null
    sku_consents?: Record<string, boolean>
  }

  // 기존 행 조회 (merge를 위해 기존 값도 함께 읽음)
  const { data: existing, error: selectError } = await supabaseAdmin
    .from('users_profile')
    .select('pid, collect_consent, collect_consent_updated_at, third_party_consent, third_party_consent_updated_at, consent_withdrawn, consent_withdrawn_updated_at, withdrawal_notified_at, sku_consents')
    .eq('user_id', userId)
    .maybeSingle()

  if (selectError) {
    console.error('[user/consent PUT] SELECT error:', selectError)
    return c.json({ error: 'DB error' }, 500)
  }

  // body에 있는 필드만 덮어쓰고, 없는 필드는 기존 DB 값 유지
  const consentFields = {
    collect_consent: body.collect_consent ?? existing?.collect_consent ?? false,
    collect_consent_updated_at: body.collect_consent_updated_at ?? existing?.collect_consent_updated_at ?? null,
    third_party_consent: body.third_party_consent ?? existing?.third_party_consent ?? false,
    third_party_consent_updated_at: body.third_party_consent_updated_at ?? existing?.third_party_consent_updated_at ?? null,
    consent_withdrawn: body.consent_withdrawn ?? existing?.consent_withdrawn ?? false,
    consent_withdrawn_updated_at: body.consent_withdrawn_updated_at ?? existing?.consent_withdrawn_updated_at ?? null,
    withdrawal_notified_at: body.withdrawal_notified_at ?? existing?.withdrawal_notified_at ?? null,
    sku_consents: body.sku_consents ?? existing?.sku_consents ?? {},
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    // 기존 행 UPDATE
    const { error: updateError } = await supabaseAdmin
      .from('users_profile')
      .update(consentFields)
      .eq('user_id', userId)

    if (updateError) {
      console.error('[user/consent PUT] UPDATE error:', updateError)
      return c.json({ error: 'DB error' }, 500)
    }
  } else {
    // 신규 행 INSERT (pid = userId)
    const { error: insertError } = await supabaseAdmin
      .from('users_profile')
      .insert({ pid: userId, user_id: userId, ...consentFields, created_at: new Date().toISOString() })

    if (insertError) {
      console.error('[user/consent PUT] INSERT error:', insertError)
      return c.json({ error: 'DB error' }, 500)
    }
  }

  return c.json({ data: consentFields })
})

export default user
