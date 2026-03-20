// ── RED: consented_at 매핑 테스트 (sessionToRow / sessionFromRow) ──────────
import { describe, it, expect, vi } from 'vitest'

// encryptId를 identity mock (암호화 없이 원본 반환)
vi.mock('../lib/crypto.js', () => ({
  encryptId: (v: string) => v,
}))

import { sessionToRow, sessionFromRow } from './sessions-helpers.js'

describe('sessionToRow — consentedAt 매핑', () => {
  it('consentedAt가 있으면 consented_at으로 변환', () => {
    const input = {
      id: 'test-1',
      title: '테스트',
      date: '2026-03-20',
      duration: 60,
      consentedAt: '2026-03-20T12:00:00.000Z',
    }
    const row = sessionToRow(input)
    expect(row.consented_at).toBe('2026-03-20T12:00:00.000Z')
  })

  it('consentedAt가 없으면 consented_at은 null', () => {
    const input = {
      id: 'test-2',
      title: '테스트2',
      date: '2026-03-20',
      duration: 30,
    }
    const row = sessionToRow(input)
    expect(row.consented_at).toBeNull()
  })

  it('consentedAt가 null이면 consented_at도 null', () => {
    const input = {
      id: 'test-3',
      title: '테스트3',
      date: '2026-03-20',
      duration: 45,
      consentedAt: null,
    }
    const row = sessionToRow(input)
    expect(row.consented_at).toBeNull()
  })
})

describe('sessionFromRow — consented_at 매핑', () => {
  it('consented_at이 있으면 consentedAt으로 변환', () => {
    const row = {
      id: 'test-1',
      title: '테스트',
      date: '2026-03-20',
      duration: 60,
      consented_at: '2026-03-20T12:00:00.000Z',
      user_id: null,
      peer_id: null,
      audio_url: null,
      call_record_id: null,
      dup_group_id: null,
      file_hash_sha256: null,
      audio_fingerprint: null,
      local_sanitized_wav_path: null,
      local_sanitized_text_preview: null,
    }
    const session = sessionFromRow(row)
    expect(session.consentedAt).toBe('2026-03-20T12:00:00.000Z')
  })

  it('consented_at이 없으면 consentedAt은 null', () => {
    const row = {
      id: 'test-2',
      title: '테스트2',
      date: '2026-03-20',
      duration: 30,
      user_id: null,
      peer_id: null,
      audio_url: null,
      call_record_id: null,
      dup_group_id: null,
      file_hash_sha256: null,
      audio_fingerprint: null,
      local_sanitized_wav_path: null,
      local_sanitized_text_preview: null,
    }
    const session = sessionFromRow(row)
    expect(session.consentedAt).toBeNull()
  })
})
