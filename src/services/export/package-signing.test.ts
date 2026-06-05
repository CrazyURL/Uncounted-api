import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { signPackage } from './package-signing.js'
import { writeFile, rm, readFile } from 'node:fs/promises'
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

const zip = path.join(tmpdir(), `sigtest_${process.pid}.zip`)

beforeAll(async () => { await writeFile(zip, Buffer.from('fake zip content 1234')) })
afterAll(async () => {
  await rm(zip, { force: true }); await rm(`${zip}.SIGNATURE.json`, { force: true })
})

describe('package-signing', () => {
  it('키 없으면 무결성 해시만(signed=false)', async () => {
    delete process.env.SIGNING_PRIVATE_KEY_PEM
    const sig = await signPackage(zip, '2026-06-05T00:00:00Z')
    expect(sig.signed).toBe(false)
    expect(sig.sha256).toMatch(/^[0-9a-f]{64}$/)
    const written = JSON.parse(await readFile(`${zip}.SIGNATURE.json`, 'utf-8'))
    expect(written.sha256).toBe(sig.sha256)
  })

  it('Ed25519 키 있으면 서명 + 검증 통과', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    process.env.SIGNING_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const sig = await signPackage(zip, '2026-06-05T00:00:00Z')
    expect(sig.signed).toBe(true)
    expect(sig.algorithm).toBe('ed25519')
    // 서명 검증
    const ok = cryptoVerify(null, await readFile(zip), publicKey, Buffer.from(sig.signature_b64!, 'base64'))
    expect(ok).toBe(true)
    delete process.env.SIGNING_PRIVATE_KEY_PEM
  })

  it('변조된 내용은 서명검증 실패', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    process.env.SIGNING_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const sig = await signPackage(zip, '2026-06-05T00:00:00Z')
    const tampered = Buffer.from('tampered content xxxx')
    const ok = cryptoVerify(null, tampered, publicKey, Buffer.from(sig.signature_b64!, 'base64'))
    expect(ok).toBe(false)
    delete process.env.SIGNING_PRIVATE_KEY_PEM
  })
})
