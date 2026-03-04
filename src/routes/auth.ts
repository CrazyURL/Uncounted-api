// ── Auth API Routes ────────────────────────────────────────────────────
// Supabase Auth 작업을 백엔드 API로 처리 (httpOnly Cookie 기반)

import { Hono } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { supabaseAdmin } from '../lib/supabase'
import { encryptId } from '../lib/crypto'
import { getBody } from '../lib/middleware'

const auth = new Hono()
const IS_PROD = process.env.NODE_ENV === 'production'

// ── 쿠키 헬퍼 ────────────────────────────────────────────────────────────

function setAuthCookies(c: Context, accessToken: string, refreshToken: string) {
  setCookie(c, 'uncounted_session', accessToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'Lax',  // Strict는 OAuth 리다이렉트 후 쿠키 차단 가능
    path: '/',
    maxAge: 60 * 60,  // 1시간 (Supabase 기본 만료와 동일)
  })
  setCookie(c, 'uncounted_refresh', refreshToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'Lax',
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
    return c.json({ error: err.message }, 500)
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
    return c.json({ error: err.message }, 500)
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
    }
    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
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
    return c.json({ data: { session: null }, error: err.message })
  }
})

/**
 * GET /auth/me
 * 쿠키 기반 현재 사용자 조회
 */
auth.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.replace('Bearer ', '')

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
    return c.json({ error: err.message }, 500)
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
    return c.json({ error: err.message }, 500)
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
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /auth/oauth/google
 * Google OAuth 플로우 시작 → Google 로그인 페이지로 리다이렉트
 */
auth.get('/oauth/google', async (c) => {
  const redirect = c.req.query('redirect') || 'http://localhost:5173/auth'

  try {
    const { data, error } = await supabaseAdmin.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirect,
      },
    })

    if (error || !data.url) {
      return c.json({ error: error?.message || 'OAuth URL 생성 실패' }, 500)
    }

    return c.redirect(data.url)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
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
    return c.json({ error: err.message }, 500)
  }
})

export default auth
