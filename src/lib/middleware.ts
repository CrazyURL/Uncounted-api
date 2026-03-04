// ── Authentication Middleware ──────────────────────────────────────────
// Supabase JWT 검증 후 userId를 context에 주입

import { Context, Next } from 'hono'
import { supabaseAdmin } from './supabase'

/**
 * Authorization: Bearer {JWT} 헤더에서 토큰 추출 → user_id 검증
 * 검증 성공 시 c.set('userId', uid) 설정
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  const token = authHeader.substring(7) // "Bearer " 제거

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    // Context에 userId 주입 (route에서 c.get('userId') 사용 가능)
    c.set('userId', user.id)
    await next()
  } catch (err) {
    console.error('[authMiddleware] Error:', err)
    return c.json({ error: 'Authentication failed' }, 500)
  }
}

/**
 * 선택적 인증 미들웨어 (토큰 있으면 검증, 없으면 통과)
 * 공개 API + 인증 시 추가 기능 제공 패턴에 사용
 */
export async function optionalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7)

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
