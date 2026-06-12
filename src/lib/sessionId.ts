// ── Session ID (server) — 앱 sessionId.ts 와 동일한 HMAC-SHA256 ──────────────
// HMAC-SHA256(SESSION_HMAC_KEY, deviceId + ":" + filePath) → 16-char hex.
// 앱(crypto.subtle)과 표준 HMAC 동일 결과 → 네이티브 ingest가 보내는 deviceId+path 로
// 서버가 동일 sessionId 를 산출(키를 클라이언트에 노출하지 않음).
// ⚠ SESSION_HMAC_KEY 환경변수는 앱 VITE_SESSION_HMAC_KEY 와 동일 값이어야 한다.

import { createHmac } from 'node:crypto'

const HMAC_KEY_HEX = process.env.SESSION_HMAC_KEY

const HEX16 = /^[0-9a-f]{16}$/

/**
 * deviceId + filePath 로 결정론적 sessionId 산출. 키 미설정 시 null.
 */
export function computeSessionId(deviceId: string, filePath: string): string | null {
  if (!HMAC_KEY_HEX) return null
  const key = Buffer.from(HMAC_KEY_HEX, 'hex')
  return createHmac('sha256', key)
    .update(`${deviceId}:${filePath}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

/** 클라이언트가 직접 보낸 sessionId 형식 검증 (16 hex). */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && HEX16.test(id)
}
