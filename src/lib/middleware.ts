// ── Authentication & Body Decryption Middleware ────────────────────────
// Bearer 토큰 또는 httpOnly Cookie(uncounted_session)에서 JWT 검증
// request body AES-256-GCM 복호화 (enc_data 포맷)

import { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { supabaseAdmin } from './supabase.js'
import { decryptData } from './crypto.js'

/**
 * POST/PUT/PATCH/DELETE 요청의 body를 읽어 컨텍스트에 저장한다.
 * enc_data 필드가 있으면 AES-256-GCM 복호화 후 저장, 없으면 raw body 저장 (하위 호환).
 * 이후 route handler에서 getBody(c)로 접근.
 */
export async function bodyDecryptMiddleware(c: Context, next: Next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    // multipart/form-data는 라우트 핸들러에서 직접 파싱 (c.req.formData())
    const contentType = c.req.header('Content-Type') ?? ''
    if (!contentType.startsWith('multipart/')) {
      try {
        const raw = await c.req.json()
        if (raw && typeof raw === 'object' && 'enc_data' in raw) {
          c.set('body', decryptData(raw.enc_data as string))
        } else {
          c.set('body', raw)
        }
      } catch { /* body 없음 또는 non-JSON — 그대로 통과 */ }
    }
  }
  await next()
}

/**
 * bodyDecryptMiddleware가 파싱한 body를 꺼낸다.
 * body가 없는 경우 빈 객체 반환 (refresh 등 optional body 처리 호환).
 */
export function getBody<T>(c: Context): T {
  return (c.get('body') ?? {}) as T
}

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
