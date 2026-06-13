// ── promoteToBothAgreed — 정식 동의/DEV 토글 공통 함수 ────────────────────
//
// 정식 동의 (POST /api/consent/agree/:token) 와 DEV 토글 (POST /api/consent/dev-test/promote)
// 양쪽이 박는 컬럼이 다르면 DEV 검증이 무의미하므로 본 함수를 통해 통일한다.
//
// 두 경로의 차이는 호출자가 넘기는 마커(consent_method)와 ip/ua/share_method 의 원천뿐.
// 박히는 컬럼 자체는 동일하다.
//
// 정식 흐름의 기존 버그 동시 수정:
//   - sessions 측 promote WHERE 가 'user_only' 만 잡아서 locked 세션은 영영 안 깨어남.
//     → 'user_only' + 'locked' 모두 promote 한다. 본인 동의 절차가 사실상 발송과 동시에
//       이뤄지는 현 운영(앱이 본인 동의 단계를 별도 호출하지 않음)을 반영.

import type { SupabaseClient } from '@supabase/supabase-js'

// 'web' = peer.html 외부 동의 (DB check 허용값, mig 047). 'manual_dev_test' = DEV 토글.
// (이전 'external' 은 consent_invitations_consent_method_check 위반 → invitation upsert 가
//  silently 실패해 status='agreed'/consent_scope 가 영영 기록 안 되던 버그를 정정.)
export type ConsentMethod = 'web' | 'manual_dev_test'

/** 상대방(counterparty)이 고른 동의 범위 (mig 085). ongoing=지금까지+앞으로 / snapshot=지금까지만 */
export type ConsentScope = 'ongoing' | 'snapshot'

export interface PromoteToBothAgreedParams {
  supabaseAdmin: SupabaseClient
  userId: string
  sessionIds: string[]
  consentMethod: ConsentMethod
  /** 정식 = peer 토큰, DEV = `dev-test-${ts}` 등 호출자가 발급한 멱등 키 */
  consenterToken: string
  ipAddress?: string | null
  userAgent?: string | null
  shareMethod?: string | null
  /** 받는 분이 peer.html 에서 고른 범위. 미전달 시 'ongoing'(과거+앞으로 모두). */
  consentScope?: ConsentScope
}

export interface PromoteToBothAgreedResult {
  sessionsPromoted: number
  invitationToken: string
  consentedAt: string
}

/**
 * sessions.consent_status 를 일괄 'both_agreed' 로 promote 하고,
 * consent_invitations 에 동의 기록을 upsert 한다.
 *
 * - sessions: WHERE consent_status IN ('user_only', 'locked') 만 promote (멱등)
 * - consent_invitations: token 기준 upsert (정식 = 사전 row update, DEV = 신규 insert)
 *
 * sessions promote 가 0 건이어도 invitation 은 기록한다 (업로드 지연 케이스 정상 처리).
 */
export async function promoteToBothAgreed(
  params: PromoteToBothAgreedParams,
): Promise<PromoteToBothAgreedResult> {
  const {
    supabaseAdmin,
    userId,
    sessionIds,
    consentMethod,
    consenterToken,
    ipAddress = null,
    userAgent = null,
    shareMethod = null,
    consentScope = 'ongoing',
  } = params

  const now = new Date().toISOString()

  // ── 1. sessions 일괄 promote ──────────────────────────────────────
  let sessionsPromoted = 0
  if (sessionIds.length > 0) {
    const { count, error } = await supabaseAdmin
      .from('sessions')
      .update(
        { consent_status: 'both_agreed', consented_at: now },
        { count: 'exact' },
      )
      .in('id', sessionIds)
      .eq('user_id', userId)
      .in('consent_status', ['user_only', 'locked'])

    if (error) {
      // 동의 의사는 invitation 측에 박을 것이므로 사용자 차단 X — 로그만.
      console.error('[promoteToBothAgreed] sessions update failed:', error)
    } else {
      sessionsPromoted = count ?? 0
      console.log(
        `[promoteToBothAgreed] sessions promoted=${sessionsPromoted}/${sessionIds.length} ` +
        `(0건은 업로드 지연 케이스 — invitation 측 기록으로 source of truth 유지)`,
      )
    }
  }

  // ── 2. consent_invitations upsert ────────────────────────────────
  // token 기준 onConflict — 정식 흐름은 기존 row 가 있고, DEV 흐름은 신규.
  const invitationRow = {
    user_id: userId,
    session_id: sessionIds[0] ?? null,
    session_ids: sessionIds,
    token: consenterToken,
    status: 'agreed' as const,
    responded_at: now,
    ip_address: ipAddress,
    user_agent: userAgent,
    share_method: shareMethod,
    consent_method: consentMethod,
    consent_scope: consentScope,
    expires_at: null,
  }

  const { error: invErr } = await supabaseAdmin
    .from('consent_invitations')
    .upsert(invitationRow, { onConflict: 'token' })

  if (invErr) {
    console.error('[promoteToBothAgreed] invitation upsert failed:', invErr)
    // sessions 가 이미 갱신됐는데 invitation 만 실패 — best-effort.
    // 호출자는 sessions promote 가 성공했다는 사실만 보장받는다.
  }

  return {
    sessionsPromoted,
    invitationToken: consenterToken,
    consentedAt: now,
  }
}
