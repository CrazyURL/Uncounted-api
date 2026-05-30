// PR-A integration test — validateExportSafety() 가 stagingDir 의
// utterances/labels/calls 파일을 sweep 하고 위반 시 violations + safetyPreflight 채우는지 검증.
// Red-Green-Restore 의 production code path 검증 단계.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

import { validateExportSafety } from './safety-checks.js'

async function mkStagingDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'safety-preflight-test-'))
}
async function rmStagingDir(dir: string): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

describe('validateExportSafety — PR-A integration', () => {
  let dir: string
  beforeEach(async () => { dir = await mkStagingDir() })
  afterEach(async () => { await rmStagingDir(dir) })

  it('정상 transcript only → safetyPreflight.status=pass, totalHits=0, no violation', async () => {
    await fs.mkdir(path.join(dir, 'utterances'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'utterances', 'utterances_demo.jsonl'),
      JSON.stringify({ id: 'u1', text: '안녕하세요 좋은 아침이에요' }) + '\n',
      'utf-8',
    )
    const r = await validateExportSafety(dir)
    expect(r.safetyPreflight.enabled).toBe(true)
    expect(r.safetyPreflight.status).toBe('pass')
    expect(r.safetyPreflight.totalHits).toBe(0)
    expect(r.violations.length).toBe(0)
  })

  it('위반 패턴 (foreign_id + credential) → fail + violations + failingCategories', async () => {
    await fs.mkdir(path.join(dir, 'calls'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'calls', 'call_demo.txt'),
      '비밀번호 Abc12345\n외국인등록증 900101-5234567\n',
      'utf-8',
    )
    const r = await validateExportSafety(dir)
    expect(r.safetyPreflight.enabled).toBe(true)
    expect(r.safetyPreflight.status).toBe('fail')
    expect(r.safetyPreflight.totalHits).toBeGreaterThanOrEqual(2)
    expect(r.safetyPreflight.failingCategories).toContain('credential_like')
    expect(r.safetyPreflight.failingCategories).toContain('foreign_id_like')
    // violations 에 preflight 위반이 포함되어 호출자 throw 대상.
    const preflightViolation = r.violations.find((v) =>
      v.includes('Export safety preflight failed'),
    )
    expect(preflightViolation).toBeDefined()
    // 원문 미포함 검증 — violation 메시지에 패스워드 본문 부재.
    expect(preflightViolation).not.toContain('Abc12345')
    expect(preflightViolation).not.toContain('900101')
  })

  it('feature flag EXPORT_SAFETY_PREFLIGHT_ENABLED=false → status=skipped, no violation', async () => {
    const prev = process.env.EXPORT_SAFETY_PREFLIGHT_ENABLED
    process.env.EXPORT_SAFETY_PREFLIGHT_ENABLED = 'false'
    try {
      await fs.mkdir(path.join(dir, 'calls'), { recursive: true })
      await fs.writeFile(
        path.join(dir, 'calls', 'call_demo.txt'),
        '비밀번호 Abc12345 외국인등록증 900101-5234567',
        'utf-8',
      )
      const r = await validateExportSafety(dir)
      expect(r.safetyPreflight.enabled).toBe(false)
      expect(r.safetyPreflight.status).toBe('skipped')
      expect(r.safetyPreflight.totalHits).toBe(0)
      const preflightViolation = r.violations.find((v) =>
        v.includes('Export safety preflight failed'),
      )
      expect(preflightViolation).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.EXPORT_SAFETY_PREFLIGHT_ENABLED
      else process.env.EXPORT_SAFETY_PREFLIGHT_ENABLED = prev
    }
  })

  it('staging 비어있음 → status=pass, scannedFiles=0', async () => {
    const r = await validateExportSafety(dir)
    expect(r.safetyPreflight.enabled).toBe(true)
    expect(r.safetyPreflight.status).toBe('pass')
    expect(r.safetyPreflight.scannedFiles).toBe(0)
  })

  it('utterances/labels/calls 외 디렉토리 파일은 미포함 sweep', async () => {
    await fs.mkdir(path.join(dir, 'metadata'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'metadata', 'dataset_summary.json'),
      JSON.stringify({ note: '비밀번호 Abc12345 metadata report 내부 텍스트' }),
      'utf-8',
    )
    const r = await validateExportSafety(dir)
    // metadata 파일은 preflight 범위 밖 → preflight 0 hit.
    expect(r.safetyPreflight.totalHits).toBe(0)
    expect(r.safetyPreflight.status).toBe('pass')
  })

  it('safetyPreflight 필드 형상 — 원문 노출 가능 키 부재', async () => {
    await fs.mkdir(path.join(dir, 'calls'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'calls', 'call_demo.txt'),
      '비밀번호 Abc12345',
      'utf-8',
    )
    const r = await validateExportSafety(dir)
    const keys = Object.keys(r.safetyPreflight)
    expect(keys).toContain('enabled')
    expect(keys).toContain('scannedFiles')
    expect(keys).toContain('totalHits')
    expect(keys).toContain('hitsByCategory')
    expect(keys).toContain('status')
    expect(keys).toContain('failingCategories')
    // 원문/raw text 키 부재 검증
    expect(keys).not.toContain('text')
    expect(keys).not.toContain('rawText')
    expect(keys).not.toContain('originalText')
    expect(keys).not.toContain('matches')
    expect(keys).not.toContain('snippet')
  })
})
