// ── Auth API Routes ────────────────────────────────────────────────────
// Supabase Auth 작업을 백엔드 API로 처리

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase'

const auth = new Hono()

// ── API 엔드포인트 ──────────────────────────────────────────────────────

/**
 * POST /auth/signin
 * 이메일/비밀번호 로그인
 */
auth.post('/signin', async (c) => {
  const { email, password } = await c.req.json()

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

    return c.json({
      data: {
        session: data.session,
        user: data.user,
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /auth/signup
 * 회원가입
 */
auth.post('/signup', async (c) => {
  const { email, password } = await c.req.json()

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
        user: data.user,
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /auth/signout
 * 로그아웃 (세션 무효화)
 */
auth.post('/signout', async (c) => {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.replace('Bearer ', '')

  if (!token) {
    return c.json({ error: 'No authorization token provided' }, 401)
  }

  try {
    // 토큰으로 사용자 확인
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user) {
      return c.json({ error: 'Invalid token' }, 401)
    }

    // 사용자의 모든 세션 무효화
    const { error } = await supabaseAdmin.auth.admin.signOut(user.id)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ data: { success: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /auth/session
 * 현재 세션 정보 조회
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
          access_token: token,
          user,
        },
      },
      error: null,
    })
  } catch (err: any) {
    return c.json({ data: { session: null }, error: err.message })
  }
})

/**
 * POST /auth/refresh
 * 리프레시 토큰으로 새 액세스 토큰 발급
 */
auth.post('/refresh', async (c) => {
  const { refresh_token } = await c.req.json()

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

    return c.json({
      data: {
        session: data.session,
      },
    })
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

  const { pid } = await c.req.json()

  if (!pid) {
    return c.json({ error: 'Pseudo ID is required' }, 400)
  }

  try {
    // 토큰으로 사용자 확인
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user) {
      return c.json({ error: 'Invalid token' }, 401)
    }

    // RPC 호출
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
