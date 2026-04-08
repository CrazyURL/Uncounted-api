// ── Hono Backend API Entry Point ───────────────────────────────────────
// Uncounted Backend API — Supabase 로직 분리

import './types.js' // Hono Context 타입 확장
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { swaggerUI } from '@hono/swagger-ui'
import { bodyDecryptMiddleware, devBodyLogger } from './lib/middleware.js'
import { openApiSpec } from './openapi.js'
import auth from './routes/auth.js'
import sessions from './routes/sessions.js'
import storage from './routes/storage.js'
import admin from './routes/admin.js'
import adminExports from './routes/admin-exports.js'
import adminLedger from './routes/admin-ledger.js'
import adminUtterances from './routes/admin-utterances.js'
import logging from './routes/logging.js'
import transcripts from './routes/transcripts.js'
import transcriptChunks from './routes/transcriptChunks.js'
import sessionChunks from './routes/sessionChunks.js'
import user from './routes/user.js'
import upload from './routes/upload.js'

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
    // 오직 CORS_ORIGIN 환경변수에 명시된 Origin만 허용 (보안 강화)
    if (allowedOrigins.includes(origin)) return origin

    // 허용되지 않은 모든 요청은 차단
    return null
  },
  credentials: true,
}))

// 로깅
app.use('/*', logger())

// request body 복호화 (enc_data → plaintext body)
app.use('/api/*', bodyDecryptMiddleware)

// 개발 환경 전용 — request/response body 로깅
app.use('/api/*', devBodyLogger)

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
app.route('/api/admin', adminExports)
app.route('/api/admin', adminLedger)
app.route('/api/admin', adminUtterances)
app.route('/api/logging', logging)
app.route('/api/transcripts', transcripts)
app.route('/api/transcript-chunks', transcriptChunks)
app.route('/api/session-chunks', sessionChunks)
app.route('/api/user', user)
app.route('/api/upload', upload)

// ── 404 핸들러 ─────────────────────────────────────────────────────────

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404)
})

// ── 에러 핸들러 ────────────────────────────────────────────────────────

app.onError((err, c) => {
  console.error('Server Error:', err)
  return c.json({ error: 'Internal Server Error' }, 500)
})

export default app
