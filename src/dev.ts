// ── Development Server ─────────────────────────────────────────────────
// Node.js로 Hono 앱 실행 (개발용)

import 'dotenv/config'
import { serve } from '@hono/node-server'
import app from './index'

const port = parseInt(process.env.PORT || '3001', 10)

console.log(`🚀 Uncounted Backend API starting on ${process.env.VITE_API_URL}`)

serve({
  fetch: app.fetch,
  port,
})
