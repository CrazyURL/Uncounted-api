/**
 * PR-C — export-builder 가 dataset_summary / dataset_quality_report / call_*.json
 * 의 session_quality_tier 를 산정해 동일 값으로 emit 하는지 통합 검증.
 *
 * Red-Green-Restore 가능 (sessionQualityTier helper 우회 시 fail).
 */
import { describe, it, expect, vi } from 'vitest'

// supabase / s3 mock — export-builder import 시 부수 효과 차단.
vi.mock('../../lib/s3.js', () => ({
  s3Client: { send: vi.fn() },
  S3_AUDIO_BUCKET: 'test-bucket',
}))
vi.mock('../../lib/supabase.js', () => ({ supabaseAdmin: {} }))

import { _testInternals } from './export-builder.js'

const { buildCallJson, buildDatasetSummary, buildDatasetQualityReport } = _testInternals

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    pid: null,
    created_at: '2026-05-31T00:00:00Z',
    audio_metadata: { sample_rate_hz: 16000 },
    session_topic_summary: null,
    session_quality_tier: null,
    consent_status: 'both_agreed',
    review_status: 'approved',
    ...overrides,
  }
}

function utt(grade: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: extra.id ?? 'u-1',
    session_id: 'sess-1',
    sequence_order: extra.sequence_order ?? 1,
    quality_grade: grade,
    duration_sec: extra.duration_sec ?? 1.0,
    ...extra,
  }
}

describe('export-builder × sessionQualityTier (PR-C 통합)', () => {
  it('DB null + utterances all A → 세 곳 모두 A_tier + source=computed', () => {
    const s = session({ session_quality_tier: null })
    const us = [utt('A', { id: 'u1' }), utt('A', { id: 'u2', sequence_order: 2 }), utt('A', { id: 'u3', sequence_order: 3 })]
    const ds = buildDatasetSummary(s as never, us as never) as Record<string, unknown>
    const dq = buildDatasetQualityReport(s as never, us as never) as Record<string, unknown>
    const cj = buildCallJson(s as never, us as never, 'reference_only') as Record<string, unknown>
    expect(ds.session_quality_tier).toBe('A_tier')
    expect(dq.session_quality_tier).toBe('A_tier')
    expect(cj.session_quality_tier).toBe('A_tier')
    expect(ds.tier_source).toBe('computed')
    expect(dq.tier_source).toBe('computed')
    expect(cj.tier_source).toBe('computed')
  })

  it('DB 값 존재 → 세 곳 모두 DB 값 + source=db', () => {
    const s = session({ session_quality_tier: 'A_tier' })
    const us = [utt('D'), utt('F', { id: 'u2', sequence_order: 2 })]  // computed=D_tier 였을 것
    const ds = buildDatasetSummary(s as never, us as never) as Record<string, unknown>
    const dq = buildDatasetQualityReport(s as never, us as never) as Record<string, unknown>
    const cj = buildCallJson(s as never, us as never, 'reference_only') as Record<string, unknown>
    expect(ds.session_quality_tier).toBe('A_tier')
    expect(dq.session_quality_tier).toBe('A_tier')
    expect(cj.session_quality_tier).toBe('A_tier')
    expect(ds.tier_source).toBe('db')
    expect(dq.tier_source).toBe('db')
    expect(cj.tier_source).toBe('db')
  })

  it('utterances=[] (deliverable filter 후 0건) → UNKNOWN', () => {
    const s = session()
    const ds = buildDatasetSummary(s as never, [] as never) as Record<string, unknown>
    const dq = buildDatasetQualityReport(s as never, [] as never) as Record<string, unknown>
    const cj = buildCallJson(s as never, [] as never, 'reference_only') as Record<string, unknown>
    expect(ds.session_quality_tier).toBe('UNKNOWN')
    expect(dq.session_quality_tier).toBe('UNKNOWN')
    expect(cj.session_quality_tier).toBe('UNKNOWN')
    expect(ds.tier_source).toBe('unknown')
  })

  it('dataset_quality_report 만 tier_reason / tier_metrics 동봉 (산정 근거)', () => {
    const s = session({ session_quality_tier: null })
    const us = [utt('A'), utt('A', { id: 'u2' }), utt('B', { id: 'u3' }), utt('B', { id: 'u4' })]
    const dq = buildDatasetQualityReport(s as never, us as never) as Record<string, unknown>
    expect(dq.tier_reason).toBe('ab_ratio>=0.9_and_df=0')
    expect(dq.tier_metrics).toEqual({ total: 4, ab_ratio: 1, df_ratio: 0 })
    // call/summary 에는 tier_reason/tier_metrics 없음 (간결).
    const cj = buildCallJson(s as never, us as never, 'embedded') as Record<string, unknown>
    expect(cj.tier_reason).toBeUndefined()
    expect(cj.tier_metrics).toBeUndefined()
    const ds = buildDatasetSummary(s as never, us as never) as Record<string, unknown>
    expect(ds.tier_reason).toBeUndefined()
    expect(ds.tier_metrics).toBeUndefined()
  })

  it('dataset_quality_report quality_grade_distribution 기존 emit 유지', () => {
    const s = session()
    const us = [utt('A'), utt('B', { id: 'u2' }), utt('B', { id: 'u3' }), utt('C', { id: 'u4' })]
    const dq = buildDatasetQualityReport(s as never, us as never) as Record<string, unknown>
    expect(dq.quality_grade_distribution).toEqual({ A: 1, B: 2, C: 1 })
  })

  it('세 곳의 tier 값 항상 일치 (단일 entry-point 보장)', () => {
    const s = session({ session_quality_tier: null })
    // C_tier 케이스
    const us = [
      ...Array.from({ length: 3 }, (_, i) => utt('A', { id: `a${i}`, sequence_order: i + 1 })),
      ...Array.from({ length: 3 }, (_, i) => utt('B', { id: `b${i}`, sequence_order: i + 4 })),
      ...Array.from({ length: 4 }, (_, i) => utt('C', { id: `c${i}`, sequence_order: i + 7 })),
    ]
    const ds = buildDatasetSummary(s as never, us as never) as Record<string, unknown>
    const dq = buildDatasetQualityReport(s as never, us as never) as Record<string, unknown>
    const cj = buildCallJson(s as never, us as never, 'reference_only') as Record<string, unknown>
    expect(ds.session_quality_tier).toBe(dq.session_quality_tier)
    expect(dq.session_quality_tier).toBe(cj.session_quality_tier)
    expect(ds.session_quality_tier).toBe('C_tier')
  })

  it('PR #58 safety preflight 와 충돌 0 — tier emit 은 sanitize 단계와 무관', () => {
    // dataset_quality_report 와 dataset_summary 는 transcript 텍스트 미포함 → preflight 의
    // utterances/*.jsonl / labels/*.jsonl / calls/*.txt|json sweep 대상에 텍스트 surface 0.
    // tier 값 (A_tier / UNKNOWN 등) 은 5 카테고리 (credential/foreign_id/payment/korean_name/
    // numeric_sensitive) 정규식 어디에도 매칭되지 않는다.
    const s = session({ session_quality_tier: null })
    const us = [utt('A')]
    const dq = buildDatasetQualityReport(s as never, us as never) as Record<string, unknown>
    const tierStr = String(dq.session_quality_tier)
    // 5 카테고리 매칭 회피 — surface 검증 (모두 false 여야 함):
    expect(/비밀번호|password|패스워드/i.test(tierStr)).toBe(false)
    expect(/\d{6}[-_\s]\d{7}/.test(tierStr)).toBe(false)
    expect(/이체|송금|결제/i.test(tierStr)).toBe(false)
    expect(/\d{6,}/.test(tierStr)).toBe(false)
  })

  it('호출자가 raw utterances (D/F 포함) 로 호출 시 → D_tier (includeRestricted=true 시나리오)', () => {
    const s = session()
    const us = [
      utt('A'), utt('A', { id: 'u2' }),
      utt('D', { id: 'd1' }), utt('D', { id: 'd2' }),
      utt('F', { id: 'f1' }), utt('F', { id: 'f2' }),
    ]
    const dq = buildDatasetQualityReport(s as never, us as never) as Record<string, unknown>
    expect(dq.session_quality_tier).toBe('D_tier')  // A+B=0.33 < 0.5
  })
})
