// export-builder orphan filter 통합 테스트.
//
// loadSessionContext 가 sessions.utterance_count 를 기준으로 orphan 행을 drop 하는지 검증.
// supabaseAdmin 을 vi.mock 으로 wrap → 단위 테스트지만 production code path 자체를 실행.
//
// 디렉터 결정(옵션 X, 2026-05-29):
//   sequence_order > sessions.utterance_count 인 행은 curated 여부와 무관하게 drop.
//   utterance_count = 0 / null → 전 utterance drop (fail-closed).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// supabaseAdmin / s3 module-level env 검증 우회.
vi.mock('../../lib/s3.js', () => ({
  s3Client: {},
  S3_AUDIO_BUCKET: 'dummy',
}))

// supabaseAdmin 을 함수별로 갈아끼울 수 있도록 mock 컨테이너 패턴.
type MaybeSingleResp = { data: unknown; error: { message: string } | null }
type ListResp = { data: unknown[]; error: { message: string } | null }

const mockState: {
  sessionsResp: MaybeSingleResp
  utterancesResp: ListResp
} = {
  sessionsResp: { data: null, error: null },
  utterancesResp: { data: [], error: null },
}

vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: {
    from(table: string) {
      if (table === 'sessions') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => mockState.sessionsResp,
            }),
          }),
        }
      }
      if (table === 'utterances') {
        return {
          select: () => ({
            eq: () => ({
              order: async () => mockState.utterancesResp,
            }),
          }),
        }
      }
      throw new Error(`unexpected table=${table}`)
    },
  },
}))

import { loadSessionContext } from './export-builder.js'

const SID = '00000000-0000-4000-8000-00000000000a'

interface UttFixture {
  id: string
  session_id: string
  sequence_order: number
  storage_path?: string | null
  transcript_text?: string | null
  pii_reviewed_at?: string | null
  pii_masked_at?: string | null
  quality_reviewed_by?: string | null
}

const utt = (seq: number, extra: Partial<UttFixture> = {}): UttFixture => ({
  id: `u-${seq}`,
  session_id: SID,
  sequence_order: seq,
  storage_path: `bucket/${SID}/utt_${seq}.wav`,
  transcript_text: `transcript ${seq}`,
  ...extra,
})

beforeEach(() => {
  delete process.env.EXPORT_ORPHAN_FILTER_ENABLED
  mockState.sessionsResp = { data: null, error: null }
  mockState.utterancesResp = { data: [], error: null }
})

describe('export-builder.loadSessionContext — orphan filter 통합', () => {
  it('정상 세션 (utterance_count = N, 모든 행 ∈ [1..N]) → 영향 0', async () => {
    mockState.sessionsResp = {
      data: { id: SID, pid: 'session-pid', utterance_count: 3 },
      error: null,
    }
    mockState.utterancesResp = {
      data: [utt(1), utt(2), utt(3)],
      error: null,
    }
    const ctx = await loadSessionContext(SID)
    expect(ctx.utterances).toHaveLength(3)
    expect(ctx.utterances.map((u) => u.sequence_order)).toEqual([1, 2, 3])
  })

  it('orphan 있는 세션 → sequence_order > utterance_count 행 drop', async () => {
    mockState.sessionsResp = {
      data: { id: SID, pid: 'p', utterance_count: 2 },
      error: null,
    }
    mockState.utterancesResp = {
      data: [utt(1), utt(2), utt(3), utt(4)],
      error: null,
    }
    const ctx = await loadSessionContext(SID)
    expect(ctx.utterances).toHaveLength(2)
    expect(ctx.utterances.map((u) => u.sequence_order)).toEqual([1, 2])
  })

  it('curated orphan (pii_reviewed_at/pii_masked_at/quality_reviewed_by 보유) 도 drop ★ 옵션 X', async () => {
    mockState.sessionsResp = {
      data: { id: SID, pid: 'p', utterance_count: 2 },
      error: null,
    }
    mockState.utterancesResp = {
      data: [
        utt(1),
        utt(2),
        utt(80, { pii_reviewed_at: '2026-05-01T00:00:00Z' }),
        utt(90, { pii_masked_at: '2026-05-01T00:00:00Z' }),
        utt(100, { quality_reviewed_by: 'admin@example' }),
      ],
      error: null,
    }
    const ctx = await loadSessionContext(SID)
    // curated 마커가 있어도 seq > utterance_count=2 → drop. 정합성 우선.
    expect(ctx.utterances.map((u) => u.sequence_order)).toEqual([1, 2])
  })

  it('utterance_count = 0 → 전 utterance drop (fail-closed, worker 실패 세션)', async () => {
    mockState.sessionsResp = {
      data: { id: SID, pid: 'p', utterance_count: 0 },
      error: null,
    }
    mockState.utterancesResp = {
      data: [utt(1), utt(2)],
      error: null,
    }
    const ctx = await loadSessionContext(SID)
    expect(ctx.utterances).toHaveLength(0)
  })

  it('utterance_count = NULL → 전 utterance drop (DB 손상 / 미초기화 방어)', async () => {
    mockState.sessionsResp = {
      data: { id: SID, pid: 'p', utterance_count: null },
      error: null,
    }
    mockState.utterancesResp = {
      data: [utt(1)],
      error: null,
    }
    const ctx = await loadSessionContext(SID)
    expect(ctx.utterances).toHaveLength(0)
  })

  it("feature flag EXPORT_ORPHAN_FILTER_ENABLED='false' → 필터 우회 (기존 동작 복원)", async () => {
    process.env.EXPORT_ORPHAN_FILTER_ENABLED = 'false'
    mockState.sessionsResp = {
      data: { id: SID, pid: 'p', utterance_count: 2 },
      error: null,
    }
    mockState.utterancesResp = {
      data: [utt(1), utt(2), utt(3), utt(4)],
      error: null,
    }
    const ctx = await loadSessionContext(SID)
    // 필터 우회 → 전 4건 (orphan 3,4 포함).
    expect(ctx.utterances).toHaveLength(4)
  })

  it('정상 row 의 ordering 보존 (drop 만 발생, reorder 0)', async () => {
    mockState.sessionsResp = {
      data: { id: SID, pid: 'p', utterance_count: 3 },
      error: null,
    }
    mockState.utterancesResp = {
      data: [utt(5), utt(1), utt(4), utt(2), utt(3)],
      error: null,
    }
    const ctx = await loadSessionContext(SID)
    // keep = seq ∈ {1,2,3}. 입력 등장 순서 보존: 5(drop)→1(keep)→4(drop)→2(keep)→3(keep)
    expect(ctx.utterances.map((u) => u.sequence_order)).toEqual([1, 2, 3])
  })

  it('sessions 조회 실패 → throw (silent 통과 금지)', async () => {
    mockState.sessionsResp = {
      data: null,
      error: { message: 'connection lost' },
    }
    await expect(loadSessionContext(SID)).rejects.toThrow(/sessions query failed/)
  })
})
