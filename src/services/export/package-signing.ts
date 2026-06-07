// 납품 패키지 암호서명 (C2PA 경량 대안). Node 내장 crypto — 신규 의존성 0.
// 무결성: ZIP SHA-256 항상 기록. 진위: 서명키(env) 있으면 Ed25519 detached 서명.
// 완전 C2PA(미디어 cert)는 데이터 ZIP 엔 과함 — 해시+서명이면 빅테크 무결성 요구 충족.
import { createHash, sign as cryptoSign, createPublicKey, createPrivateKey } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

export interface PackageSignature {
  algorithm: string
  sha256: string
  signed: boolean
  signature_b64?: string
  public_key_pem?: string
  signed_at: string
  note?: string
}

/** ZIP 의 SHA-256 + (키 있으면) Ed25519 서명을 산출하고 SIGNATURE.json 을 ZIP 옆에 쓴다. */
export async function signPackage(zipPath: string, signedAtIso: string): Promise<PackageSignature> {
  const buf = await readFile(zipPath)
  const sha256 = createHash('sha256').update(buf).digest('hex')

  let sig: PackageSignature = {
    algorithm: 'sha256',
    sha256,
    signed: false,
    signed_at: signedAtIso,
    note: 'SIGNING_PRIVATE_KEY_PEM 미설정 — 무결성 해시만(서명 없음).',
  }

  const pem = process.env.SIGNING_PRIVATE_KEY_PEM
  if (pem) {
    try {
      const privateKey = createPrivateKey(pem)
      // Ed25519: digest=null (one-shot). 다른 키타입이면 sha256 으로 서명.
      const isEd = privateKey.asymmetricKeyType === 'ed25519' || privateKey.asymmetricKeyType === 'ed448'
      const signature = cryptoSign(isEd ? null : 'sha256', buf, privateKey)
      const pubPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
      sig = {
        algorithm: isEd ? `${privateKey.asymmetricKeyType}` : 'rsa-sha256',
        sha256,
        signed: true,
        signature_b64: signature.toString('base64'),
        public_key_pem: pubPem,
        signed_at: signedAtIso,
      }
    } catch (e) {
      sig.note = `서명 실패(${(e as Error).message.slice(0, 60)}) — 무결성 해시만.`
    }
  }

  await writeFile(`${zipPath}.SIGNATURE.json`, JSON.stringify(sig, null, 2), 'utf-8')
  return sig
}
