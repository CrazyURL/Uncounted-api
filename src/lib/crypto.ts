// ── AES-256-GCM 암호화 유틸 ───────────────────────────────────────────────
// Node.js 내장 crypto 모듈 사용 — 추가 의존성 없음
// 출력 포맷: base64url( IV(12B) | AuthTag(16B) | Ciphertext ) + '@enc_uncounted'

import { createCipheriv, randomBytes } from 'node:crypto'

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!  // 32바이트 hex (64자)

const ENC_SUFFIX = '@enc_uncounted'

export function encryptId(plaintext: string): string {
  const key = Buffer.from(ENCRYPTION_KEY, 'hex')
  const iv = randomBytes(12)                         // GCM 표준: 96-bit IV
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()                // 16바이트

  return Buffer.concat([iv, authTag, encrypted]).toString('base64url') + ENC_SUFFIX
}
