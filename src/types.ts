// ── Hono Type Extensions ──────────────────────────────────────────────
// Context에 userId 변수 타입 확장

import 'hono'

declare module 'hono' {
  interface ContextVariableMap {
    userId: string
  }
}
