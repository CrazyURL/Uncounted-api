// ── AES-256-GCM 암호화/복호화 유틸 ────────────────────────────────────────
// Node.js 내장 crypto 모듈 사용 — 추가 의존성 없음
// 응답 암호화 포맷: base64url( IV(12B) | AuthTag(16B) | Ciphertext ) + '@enc_uncounted'
// 요청 복호화 포맷: base64url( IV(12B) | AuthTag(16B) | Ciphertext )  (suffix 없음)

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

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

/**
 * encryptId()로 암호화된 값을 원래 plaintext로 복호화한다.
 * 포맷: base64url( IV(12B) | AuthTag(16B) | Ciphertext ) + '@enc_uncounted'
 */
export function decryptId(encryptedId: string): string {
  const suffix = ENC_SUFFIX
  if (!encryptedId.endsWith(suffix)) {
    throw new Error('Invalid encryptId format: missing suffix')
  }
  const key  = Buffer.from(ENCRYPTION_KEY, 'hex')
  const data = Buffer.from(encryptedId.slice(0, -suffix.length), 'base64url')
  const iv         = data.subarray(0, 12)
  const authTag    = data.subarray(12, 28)
  const ciphertext = data.subarray(28)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}

/**
 * 클라이언트가 암호화한 request body를 복호화한다.
 * 포맷: base64url( IV(12B) | AuthTag(16B) | Ciphertext )  — suffix 없음
 * 클라이언트 crypto.ts의 encryptData()와 대칭.
 */
export function decryptData(encData: string): unknown {
  const key  = Buffer.from(ENCRYPTION_KEY, 'hex')
  const data = Buffer.from(encData, 'base64url')
  const iv         = data.subarray(0, 12)
  const authTag    = data.subarray(12, 28)
  const ciphertext = data.subarray(28)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(decrypted.toString('utf8'))
}
