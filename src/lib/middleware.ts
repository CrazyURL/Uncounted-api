// ── Authentication Middleware ──────────────────────────────────────────
// Bearer 토큰 또는 httpOnly Cookie(uncounted_session)에서 JWT 검증

import { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { supabaseAdmin } from './supabase'

/**
 * Authorization: Bearer {JWT} 헤더 또는 uncounted_session 쿠키에서 토큰 추출
 * 검증 성공 시 c.set('userId', uid) 설정
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null
  const cookieToken = getCookie(c, 'uncounted_session')
  const token = bearerToken || cookieToken

  if (!token) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    c.set('userId', user.id)
    await next()
  } catch (err) {
    console.error('[authMiddleware] Error:', err)
    return c.json({ error: 'Authentication failed' }, 500)
  }
}

/**
 * 선택적 인증 미들웨어 (토큰 있으면 검증, 없으면 통과)
 * Bearer 토큰 또는 쿠키 모두 지원
 */
export async function optionalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null
  const cookieToken = getCookie(c, 'uncounted_session')
  const token = bearerToken || cookieToken

  if (token) {
    try {
      const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)
      if (!error && user) {
        c.set('userId', user.id)
      }
    } catch {
      // 검증 실패 시 무시 (선택적 인증)
    }
  }

  await next()
}
