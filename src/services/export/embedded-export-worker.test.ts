// embedded-export-worker 단위 테스트.
// supabase / s3 / buildSessionExportZip / eligibility / node:fs 를 mock 하여
// queued→packaging→ready/failed 전이, eligibility 2차 체크, finally cleanup 을 검증.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mocks ────────────────────────────────────────────────────────────────
const buildSessionExportZip = vi.fn()
vi.mock('./export-builder.js', () => ({ buildSessionExportZip: (...a: unknown[]) => buildSessionExportZip(...a) }))

const isExportEligible = vi.fn()
vi.mock('../../lib/export/eligibility.js', () => ({ isExportEligible: (...a: unknown[]) => isExportEligible(...a) }))

const s3Send = vi.fn(async () => ({}))
vi.mock('../../lib/s3.js', () => ({ s3Client: { send: (...a: unknown[]) => s3Send(...a) }, S3_AUDIO_BUCKET: 'bucket' }))

const fsStat = vi.fn(async () => ({ size: 4242 }))
const fsUnlink = vi.fn(async () => {})
vi.mock('node:fs', () => ({
  createReadStream: vi.fn(() => 'fake-stream'),
  promises: { stat: (...a: unknown[]) => fsStat(...a), unlink: (...a: unknown[]) => fsUnlink(...a) },
}))

// supabase mock: 공유 jobRow/sessionRow 에 update 를 적용. claim(.select('id')) 은 성공 처리.
let jobRow: Record<string, unknown>
let sessionRow: Record<string, unknown> | null

function makeBuilder(table: string) {
  let op: 'select' | 'update' | null = null
  let payload: Record<string, unknown> | null = null
  const settle = () => {
    if (op === 'update' && payload) {
      Object.assign(jobRow, payload)
      return { data: [{ id: jobRow.id }], error: null }
    }
    if (table === 'export_jobs_v2') return { data: jobRow, error: null }
    if (table === 'sessions') return { data: sessionRow, error: null }
    return { data: null, error: null }
  }
  const b: Record<string, unknown> = {
    select: () => b,
    update: (p: Record<string, unknown>) => { op = 'update'; payload = p; return b },
    insert: (p: Record<string, unknown>) => { op = 'update'; payload = p; return b },
    eq: () => b,
    in: () => b,
    single: () => Promise.resolve(settle()),
    maybeSingle: () => Promise.resolve(settle()),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
  }
  return b
}
vi.mock('../../lib/supabase.js', () => ({ supabaseAdmin: { from: (t: string) => makeBuilder(t) } }))

import { runEmbeddedExportJob } from './embedded-export-worker.js'

beforeEach(() => {
  vi.clearAllMocks()
  jobRow = {
    id: 'job1',
    status: 'queued',
    session_ids: ['sessA'],
    audio_export_mode: 'embedded',
    include_restricted: false,
  }
  sessionRow = { consent_status: 'both_agreed', review_status: 'approved', session_dataset_eligible: true }
  isExportEligible.mockReturnValue({ eligible: true })
  buildSessionExportZip.mockResolvedValue({ zipPath: '/tmp/x.zip', manifest: {}, safety: { violations: [], warnings: [] } })
})

describe('runEmbeddedExportJob', () => {
  it('happy path: queued→ready, storage_path/size 저장, download_url 미저장, embedded+restricted:false 호출', async () => {
    await runEmbeddedExportJob('job1')

    expect(buildSessionExportZip).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sessA', audioExportMode: 'embedded', includeRestricted: false }),
    )
    expect(s3Send).toHaveBeenCalledTimes(1)
    expect(jobRow.status).toBe('ready')
    expect(typeof jobRow.storage_path).toBe('string')
    expect(jobRow.size_bytes).toBe(4242)
    expect(jobRow.download_url).toBeUndefined() // DB 에 download_url 저장 금지
    expect(fsUnlink).toHaveBeenCalledTimes(1) // finally cleanup
  })

  it('2차 eligibility 부적격 → failed/export_ineligible, 빌드 미호출', async () => {
    isExportEligible.mockReturnValue({ eligible: false, reason: 'review_not_approved' })

    await runEmbeddedExportJob('job1')

    expect(buildSessionExportZip).not.toHaveBeenCalled()
    expect(jobRow.status).toBe('failed')
    expect(jobRow.error_message).toBe('export_ineligible')
  })

  it('빌드 throw → failed + cleanup(finally) 보장', async () => {
    buildSessionExportZip.mockRejectedValue(new Error('boom'))

    await runEmbeddedExportJob('job1')

    expect(jobRow.status).toBe('failed')
    expect(jobRow.error_message).toBe('boom')
    // zipPath 가 set 되기 전 throw 이므로 unlink 는 호출되지 않을 수 있음 — 빌드 실패는 zipPath null
    expect(fsUnlink).not.toHaveBeenCalled()
  })

  it('빌드 후 업로드 단계 throw → failed + cleanup 호출', async () => {
    s3Send.mockRejectedValueOnce(new Error('s3 down'))

    await runEmbeddedExportJob('job1')

    expect(jobRow.status).toBe('failed')
    expect(jobRow.error_message).toBe('s3 down')
    expect(fsUnlink).toHaveBeenCalledTimes(1) // zipPath set 후 실패 → cleanup
  })
})
