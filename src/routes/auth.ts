// ── Auth API Routes ────────────────────────────────────────────────────
// Supabase Auth 작업을 백엔드 API로 처리 (httpOnly Cookie 기반)

import { Hono } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { supabaseAdmin } from '../lib/supabase.js'
import { encryptId } from '../lib/crypto.js'
import { getBody } from '../lib/middleware.js'

const auth = new Hono()
const IS_PROD = process.env.NODE_ENV === 'production'

/**
 * 만료된 JWT에서도 user ID(sub)를 추출한다.
 * JWT payload는 서명 검증 없이 디코딩 가능하며,
 * signOut 용도로는 user ID만 필요하므로 안전하다.
 */
function extractUserIdFromJwt(token: string): string | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    return payload.sub || null
  } catch {
    return null
  }
}

// ── PKCE 상태 저장소 (Supabase DB) ────────────────────────────────────────

// ── 쿠키 헬퍼 ────────────────────────────────────────────────────────────

function setAuthCookies(c: Context, accessToken: string, refreshToken: string) {
  setCookie(c, 'uncounted_session', accessToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'none',  // Strict는 OAuth 리다이렉트 후 쿠키 차단 가능
    path: '/',
    maxAge: 60 * 60,  // 1시간 (Supabase 기본 만료와 동일)
  })
  setCookie(c, 'uncounted_refresh', refreshToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'none',
    path: '/',
    maxAge: 60 * 60 * 24 * 90,  // 90일 (Supabase 기본값)
  })
}

function clearAuthCookies(c: Context) {
  deleteCookie(c, 'uncounted_session', { path: '/' })
  deleteCookie(c, 'uncounted_refresh', { path: '/' })
}

// ── API 엔드포인트 ──────────────────────────────────────────────────────

/**
 * POST /auth/signin
 * 이메일/비밀번호 로그인 → httpOnly 쿠키 설정
 */
auth.post('/signin', async (c) => {
  const { email, password } = getBody<{ email: string; password: string }>(c)

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400)
  }

  try {
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      return c.json({ error: error.message }, 401)
    }

    if (data.session?.access_token && data.session?.refresh_token) {
      setAuthCookies(c, data.session.access_token, data.session.refresh_token)
    }

    return c.json({
      data: {
        session: data.session ? {
          access_token: encryptId(data.session.access_token),
          refresh_token: encryptId(data.session.refresh_token),
        } : null,
        user: data.user ? {
          id: encryptId(data.user.id),
          email: data.user.email ? encryptId(data.user.email) : null,
        } : null,
      },
    })
  } catch (err: any) {
    console.error('[signin] Error:', err)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

/**
 * POST /auth/signup
 * 회원가입 (이메일 확인 자동 처리)
 */
auth.post('/signup', async (c) => {
  const { email, password } = getBody<{ email: string; password: string }>(c)

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400)
  }

  try {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })

    if (error) {
      return c.json({ error: error.message }, 400)
    }

    return c.json({
      data: {
        user: data.user ? {
          id: encryptId(data.user.id),
          email: data.user.email ? encryptId(data.user.email) : null,
        } : null,
      },
    })
  } catch (err: any) {
    console.error('[signup] Error:', err)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

/**
 * POST /auth/signout
 * 로그아웃 (쿠키 삭제 + Supabase 세션 무효화)
 */
auth.post('/signout', async (c) => {
  const authHeader = c.req.header('Authorization')
  const bearerToken = authHeader?.replace('Bearer ', '') || null
  const cookieToken = getCookie(c, 'uncounted_session')
  const token = bearerToken || cookieToken

  // 토큰 없어도 쿠키 삭제 후 성공 반환 (이미 로그아웃 상태)
  clearAuthCookies(c)

  if (!token) {
    return c.json({ data: { success: true } })
  }

  try {
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token)
    if (!userError && user) {
      await supabaseAdmin.auth.admin.signOut(user.id)
    } else {
      // 토큰 만료 시에도 JWT payload에서 userId를 추출하여 세션 revoke
      const userId = extractUserIdFromJwt(token)
      if (userId) {
        await supabaseAdmin.auth.admin.signOut(userId)
      }
    }
    return c.json({ data: { success: true } })
  } catch (err: any) {
    console.error('[signout] Error:', err)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

/**
 * GET /auth/session
 * 현재 세션 정보 조회 (기존 호환 유지)
 */
auth.get('/session', async (c) => {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.replace('Bearer ', '')

  if (!token) {
    return c.json({ data: { session: null }, error: null })
  }

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      return c.json({ data: { session: null }, error: null })
    }

    return c.json({
      data: {
        session: {
          access_token: encryptId(token),
          user: {
            id: encryptId(user.id),
            email: user.email ? encryptId(user.email) : null,
          },
        },
      },
      error: null,
    })
  } catch (err: any) {
    console.error('[session GET] Error:', err)
    return c.json({ data: { session: null }, error: 'Internal Server Error' })
  }
})

/**
 * GET /auth/me
 * 쿠키 기반 현재 사용자 조회
 */
auth.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.replace('Bearer ', '') || getCookie(c, 'uncounted_session')

  if (!token) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      clearAuthCookies(c)
      return c.json({ error: 'Invalid or expired session' }, 401)
    }

    return c.json({ data: { user: { id: encryptId(user.id), email: user.email ? encryptId(user.email) : null } } })
  } catch (err: any) {
    console.error('[me] Error:', err)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

/**
 * POST /auth/refresh
 * 리프레시 토큰으로 새 액세스 토큰 발급
 * body 또는 쿠키에서 refresh_token 읽기
 */
auth.post('/refresh', async (c) => {
  const body = getBody<{ refresh_token?: string }>(c)
  const refresh_token = body.refresh_token || getCookie(c, 'uncounted_refresh')

  if (!refresh_token) {
    return c.json({ error: 'Refresh token is required' }, 400)
  }

  try {
    const { data, error } = await supabaseAdmin.auth.refreshSession({
      refresh_token,
    })

    if (error) {
      return c.json({ error: error.message }, 401)
    }

    if (data.session?.access_token && data.session?.refresh_token) {
      setAuthCookies(c, data.session.access_token, data.session.refresh_token)
    }

    return c.json({
      data: {
        session: data.session ? {
          access_token: encryptId(data.session.access_token),
          refresh_token: data.session.refresh_token ? encryptId(data.session.refresh_token) : null,
        } : null,
      },
    })
  } catch (err: any) {
    console.error('[refresh] Error:', err)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

/**
 * POST /auth/session
 * OAuth 콜백 후 프론트엔드에서 토큰 전달 → 쿠키 설정
 */
auth.post('/session', async (c) => {
  const { access_token, refresh_token } = getBody<{ access_token: string; refresh_token: string }>(c)

  if (!access_token || !refresh_token) {
    return c.json({ error: 'access_token and refresh_token are required' }, 400)
  }

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(access_token)

    if (error || !user) {
      return c.json({ error: 'Invalid token' }, 401)
    }

    setAuthCookies(c, access_token, refresh_token)

    return c.json({
      data: {
        session: {
          access_token: encryptId(access_token),
          user: {
            id: encryptId(user.id),
            email: user.email ? encryptId(user.email) : null,
          },
        },
      },
    })
  } catch (err: any) {
    console.error('[session POST] Error:', err)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

/**
 * GET /auth/oauth/google
 * Google OAuth 플로우 시작 (PKCE)
 * - 클라이언트가 code_challenge를 제공하면 그대로 사용 (네이티브 플로우)
 * - code_challenge 없으면 서버에서 생성 후 쿠키로 매핑 (웹 플로우)
 */
auth.get('/oauth/google', async (c) => {
  const frontendRedirect = c.req.query('redirect') || 'http://localhost:5173/auth'
  const clientCodeChallenge = c.req.query('code_challenge')

  let codeChallenge: string

  if (clientCodeChallenge) {
    // 네이티브 플로우: 클라이언트가 PKCE를 직접 생성/보관
    codeChallenge = clientCodeChallenge
  } else {
    // 웹 플로우: 서버에서 PKCE 생성 후 쿠키로 flowId 매핑
    const codeVerifier = randomBytes(32).toString('base64url')
    codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const flowId = randomUUID()

    const { error: pkceInsertError } = await supabaseAdmin
      .from('pkce_store')
      .insert({
        flow_id: flowId,
        code_verifier: codeVerifier,
        frontend_redirect: frontendRedirect,
      })

    if (pkceInsertError) {
      console.error('pkce_store insert failed:', pkceInsertError)
      return c.json({ error: 'Internal Server Error' }, 500)
    }

    setCookie(c, 'pkce_flow_id', flowId, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      path: '/',
      maxAge: 60 * 5,
    })
  }

  const authUrl = new URL(`${process.env.SUPABASE_URL}/auth/v1/authorize`)
  authUrl.searchParams.set('provider', 'google')
  authUrl.searchParams.set('redirect_to', frontendRedirect)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 's256')

  return c.redirect(authUrl.toString())
})

/**
 * GET /auth/oauth/callback
 * Supabase OAuth 콜백 수신 → PKCE 코드 교환 → 쿠키 설정
 * - 네이티브 플로우: 클라이언트가 code_verifier를 쿼리 파라미터로 전달
 * - 웹 플로우: 쿠키의 pkce_flow_id로 서버 저장 code_verifier 조회
 */
auth.get('/oauth/callback', async (c) => {
  const code = c.req.query('code')
  const errorParam = c.req.query('error')
  const clientCodeVerifier = c.req.query('code_verifier')

  if (errorParam) {
    return c.json({ error: errorParam }, 400)
  }

  if (!code) {
    return c.json({ error: 'missing_params' }, 400)
  }

  let codeVerifier: string

  if (clientCodeVerifier) {
    // 네이티브 플로우: 클라이언트가 code_verifier를 직접 전달
    codeVerifier = clientCodeVerifier
  } else {
    // 웹 플로우: 쿠키로 flowId 조회 후 서버 저장 code_verifier 사용
    const flowId = getCookie(c, 'pkce_flow_id')
    deleteCookie(c, 'pkce_flow_id', { path: '/' })

    if (!flowId) {
      return c.json({ error: 'missing_params' }, 400)
    }

    const { data: pkceState, error: pkceSelectError } = await supabaseAdmin
      .from('pkce_store')
      .select('code_verifier, expires_at')
      .eq('flow_id', flowId)
      .maybeSingle()

    // 조회 후 즉시 삭제 (일회용)
    await supabaseAdmin.from('pkce_store').delete().eq('flow_id', flowId)

    if (pkceSelectError || !pkceState || new Date(pkceState.expires_at) < new Date()) {
      return c.json({ error: 'invalid_state' }, 400)
    }
    codeVerifier = pkceState.code_verifier
  }

  // Supabase PKCE 토큰 교환
  const tokenRes = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/token?grant_type=pkce`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY!,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: codeVerifier,
      }),
    }
  )

  if (!tokenRes.ok) {
    const errText = await tokenRes.text()
    console.error('PKCE token exchange failed:', errText)
    return c.json({ error: 'token_exchange_failed' }, 400)
  }

  const { access_token, refresh_token } = await tokenRes.json() as { access_token: string; refresh_token: string }

  setAuthCookies(c, access_token, refresh_token)
  return c.json({
    success: true,
    data: {
      session: {
        access_token: encryptId(access_token),
        refresh_token: encryptId(refresh_token),
      },
    },
  })
})

/**
 * POST /auth/link-pid
 * Pseudo ID를 User ID에 연결 (RPC 호출)
 */
auth.post('/link-pid', async (c) => {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.replace('Bearer ', '')

  if (!token) {
    return c.json({ error: 'Authorization required' }, 401)
  }

  const { pid } = getBody<{ pid: string }>(c)

  if (!pid) {
    return c.json({ error: 'Pseudo ID is required' }, 400)
  }

  try {
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user) {
      return c.json({ error: 'Invalid token' }, 401)
    }

    const { error } = await supabaseAdmin.rpc('link_pid_to_user', {
      p_pid: pid,
      p_user_id: user.id,
    })

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ data: { success: true } })
  } catch (err: any) {
    console.error('[link-pid] Error:', err)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

export default auth
