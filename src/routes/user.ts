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

  // ── PIPA 동의 완료 시 기존 세션 일괄 동기화 ──────────────────────────
  // collect_consent + third_party_consent 모두 true이고 철회 아닌 경우
  // 해당 사용자의 locked 세션을 user_only로 승격
  const isFullyConsented =
    consentFields.collect_consent &&
    consentFields.third_party_consent &&
    !consentFields.consent_withdrawn

  if (isFullyConsented) {
    const today = new Date().toISOString().slice(0, 10)
    try {
      const { data: updated, error: syncErr } = await supabaseAdmin
        .from('sessions')
        .update({
          consent_status: 'user_only',
          is_public: true,
          visibility_status: 'PUBLIC_CONSENTED',
          visibility_source: 'GLOBAL_DEFAULT',
          visibility_changed_at: today,
        })
        .eq('user_id', userId)
        .eq('consent_status', 'locked')
        .select('id')

      const syncCount = updated?.length ?? 0
      if (syncErr) {
        console.error('[user/consent PUT] session sync error:', syncErr)
      } else if (syncCount > 0) {
        // billable_units도 동기화
        await supabaseAdmin
          .from('billable_units')
          .update({ consent_status: 'PUBLIC_CONSENTED' })
          .eq('user_id', userId)
          .eq('consent_status', 'PRIVATE')

        console.log(`[user/consent PUT] session sync: ${syncCount}건 user_only 전환`)
      }
    } catch (err) {
      console.error('[user/consent PUT] session sync failed:', err)
    }
  }

  // ── 동의 철회 시 기존 세션 되돌리기 ────────────────────────────────────
  if (consentFields.consent_withdrawn) {
    try {
      const { data: reverted, error: revertErr } = await supabaseAdmin
        .from('sessions')
        .update({
          consent_status: 'locked',
          is_public: false,
          visibility_status: 'PRIVATE',
          visibility_source: 'GLOBAL_DEFAULT',
          visibility_changed_at: new Date().toISOString().slice(0, 10),
        })
        .eq('user_id', userId)
        .in('consent_status', ['user_only', 'both_agreed'])
        .select('id')

      const revertCount = reverted?.length ?? 0
      if (revertErr) {
        console.error('[user/consent PUT] consent withdrawal sync error:', revertErr)
      } else if (revertCount > 0) {
        await supabaseAdmin
          .from('billable_units')
          .update({ consent_status: 'PRIVATE' })
          .eq('user_id', userId)
          .in('consent_status', ['PUBLIC_CONSENTED'])

        console.log(`[user/consent PUT] consent withdrawn: ${revertCount}건 locked 전환`)
      }
    } catch (err) {
      console.error('[user/consent PUT] withdrawal sync failed:', err)
    }
  }

  return c.json({ data: consentFields })
})

// ── GET /api/user/voice-profile ─────────────────────────────────────────────
// 서버 저장된 목소리 등록 프로필 조회. 없으면 null 반환.

user.get('/voice-profile', async (c) => {
  const userId = c.get('userId') as string

  const { data, error } = await supabaseAdmin
    .from('voice_profiles')
    .select(
      'enrollment_status, embeddings, reference_embedding, enrollment_count, min_enrollments, enrolled_at, updated_at, origin_reference_embedding, origin_confirmed_at, drift_from_origin, drift_event_count, clean_calls, processed_calls',
    )
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[voice-profile GET] DB error:', error)
    return c.json({ error: 'DB error' }, 500)
  }

  if (!data) return c.json({ data: null })

  return c.json({
    data: {
      enrollmentStatus: data.enrollment_status,
      embeddings: data.embeddings ?? [],
      referenceEmbedding: data.reference_embedding ?? null,
      enrollmentCount: data.enrollment_count,
      minEnrollments: data.min_enrollments,
      enrolledAt: data.enrolled_at ?? null,
      updatedAt: data.updated_at ?? null,
      // Origin Anchor (마이그레이션 042, 2026-04-29)
      originReferenceEmbedding: data.origin_reference_embedding ?? null,
      originConfirmedAt: data.origin_confirmed_at ?? null,
      driftFromOrigin: data.drift_from_origin ?? null,
      driftEventCount: data.drift_event_count ?? 0,
      cleanCalls: data.clean_calls ?? 0,
      processedCalls: data.processed_calls ?? 0,
    },
  })
})

// ── PUT /api/user/voice-profile ──────────────────────────────────────────────
// 목소리 등록 프로필 저장/업데이트 (upsert). 등록 완료 프로필만 허용.

user.put('/voice-profile', async (c) => {
  const userId = c.get('userId') as string
  const body = getBody(c) as {
    enrollmentStatus: string
    embeddings: unknown[]
    referenceEmbedding: unknown[] | null
    enrollmentCount: number
    minEnrollments: number
    enrolledAt: string | null
    updatedAt: string | null
    // Origin Anchor (선택 — 신규 enrollment 시 origin도 함께 전달)
    originReferenceEmbedding?: unknown[] | null
    originConfirmedAt?: string | null
  }

  if (body.enrollmentStatus !== 'enrolled') {
    return c.json({ error: 'enrolled 상태만 저장 가능합니다' }, 400)
  }

  if (!Array.isArray(body.embeddings) || body.embeddings.length > 20) {
    return c.json({ error: 'embeddings: 배열이어야 하며 최대 20개입니다' }, 400)
  }

  if (body.referenceEmbedding !== null && (!Array.isArray(body.referenceEmbedding) || body.referenceEmbedding.length > 256)) {
    return c.json({ error: 'referenceEmbedding: 최대 256개의 숫자 배열이어야 합니다' }, 400)
  }

  // Origin Anchor 보호: 기존 origin이 있으면 절대 덮어쓰지 않음 (이탈 감지의 기준선)
  const { data: existing } = await supabaseAdmin
    .from('voice_profiles')
    .select('origin_reference_embedding, origin_confirmed_at')
    .eq('user_id', userId)
    .maybeSingle()

  const now = new Date().toISOString()
  const hasExistingOrigin = !!existing?.origin_reference_embedding

  // 최초 enrollment 시에만 origin 설정. 이후 PUT은 origin 컬럼 미변경.
  const originUpdate = hasExistingOrigin
    ? {}
    : {
        origin_reference_embedding:
          body.originReferenceEmbedding ?? body.referenceEmbedding,
        origin_confirmed_at: body.originConfirmedAt ?? now,
      }

  const { error } = await supabaseAdmin
    .from('voice_profiles')
    .upsert(
      {
        user_id: userId,
        enrollment_status: body.enrollmentStatus,
        embeddings: body.embeddings,
        reference_embedding: body.referenceEmbedding,
        enrollment_count: body.enrollmentCount,
        min_enrollments: body.minEnrollments,
        enrolled_at: body.enrolledAt,
        updated_at: now,
        created_at: now,
        ...originUpdate,
      },
      { onConflict: 'user_id' },
    )

  if (error) {
    console.error('[voice-profile PUT] DB error:', error)
    return c.json({ error: 'DB error' }, 500)
  }

  return c.json({ data: { ok: true } })
})

// ── DELETE /api/user/voice-profile ───────────────────────────────────────────
// 목소리 등록 프로필 삭제 (앱 내 등록 초기화와 연동).

user.delete('/voice-profile', async (c) => {
  const userId = c.get('userId') as string

  const { error } = await supabaseAdmin
    .from('voice_profiles')
    .delete()
    .eq('user_id', userId)

  if (error) {
    console.error('[voice-profile DELETE] DB error:', error)
    return c.json({ error: 'DB error' }, 500)
  }

  return c.json({ data: { ok: true } })
})

export default user
