// ── Hono Backend API Entry Point ───────────────────────────────────────
// Uncounted Backend API — Supabase 로직 분리

import './types' // Hono Context 타입 확장
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { swaggerUI } from '@hono/swagger-ui'
import { bodyDecryptMiddleware } from './lib/middleware'
import { openApiSpec } from './openapi'
import auth from './routes/auth'
import sessions from './routes/sessions'
import storage from './routes/storage'
import admin from './routes/admin'
import logging from './routes/logging'
import transcripts from './routes/transcripts'

const app = new Hono()

// ── 미들웨어 ────────────────────────────────────────────────────────────

// CORS (프론트엔드 origin 허용)
// CORS_ORIGIN 환경변수는 콤마로 구분된 복수 origin 지원
// 예: CORS_ORIGIN=http://localhost:5173,https://app.example.com
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

app.use('/*', cors({
  origin: (origin) => {
    if (!allowedOrigins.length) return '*'
    return allowedOrigins.includes(origin) ? origin : allowedOrigins[0]
  },
  credentials: true,
}))

// 로깅
app.use('/*', logger())

// request body 복호화 (enc_data → plaintext body)
app.use('/api/*', bodyDecryptMiddleware)

// ── 헬스 체크 ──────────────────────────────────────────────────────────

app.get('/', (c) => {
  return c.json({
    service: 'Uncounted Backend API',
    version: '1.0.0',
    status: 'healthy',
    timestamp: new Date().toISOString(),
  })
})

app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

// ── API 문서 ───────────────────────────────────────────────────────────

app.get('/docs', swaggerUI({ url: '/openapi.json' }))
app.get('/openapi.json', (c) => c.json(openApiSpec))

// ── API 라우트 ─────────────────────────────────────────────────────────

app.route('/api/auth', auth)
app.route('/api/sessions', sessions)
app.route('/api/storage', storage)
app.route('/api/admin', admin)
app.route('/api/logging', logging)
app.route('/api/transcripts', transcripts)

// ── 404 핸들러 ─────────────────────────────────────────────────────────

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404)
})

// ── 에러 핸들러 ────────────────────────────────────────────────────────

app.onError((err, c) => {
  console.error('Server Error:', err)
  return c.json(
    {
      error: 'Internal Server Error',
      message: err.message,
    },
    500
  )
})

export default app
