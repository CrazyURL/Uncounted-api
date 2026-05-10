// ── Development Server ─────────────────────────────────────────────────
// Node.js로 Hono 앱 실행 (개발용)

import 'dotenv/config'
import { setGlobalDispatcher, ProxyAgent } from 'undici'
import { serve } from '@hono/node-server'
import app from './index.js'
import { startGpuWorker, stopGpuWorker } from './services/gpu-worker.js'

// BM v10 — Render container 내 Tailscale userspace networking.
// HTTP_PROXY 가 설정되면 (render-start.sh 가 설정) 모든 fetch 가 Tailnet
// 경유. voice_api (Tailscale 망 안) 호출 가능 + 외부 HTTPS 도 동일 경로.
const httpProxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY
if (httpProxy) {
  setGlobalDispatcher(new ProxyAgent(httpProxy))
  console.log(`[fetch] global ProxyAgent → ${httpProxy}`)
}

const port = parseInt(process.env.PORT || '3001', 10)

console.log(`🚀 Uncounted Backend API starting on ${process.env.VITE_API_URL}`)

// BM v10 GPU 워커 — GPU_WORKER_ENABLED=true 인스턴스만 활성
if (process.env.GPU_WORKER_ENABLED === 'true') {
  startGpuWorker()
}

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  () => {
    // PM2 wait_ready: cluster 무중단 reload 지원
    if (typeof process.send === 'function') {
      process.send('ready')
    }
  },
)

const shutdown = (signal: string) => {
  console.log(`[${signal}] graceful shutdown start`)
  stopGpuWorker()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 4500).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
