import { describe, it, expect } from 'vitest'
import {
  buildRunningOrClause,
  distinctSessionIds,
  countCandidatesBySession,
} from './admin-reviews-helpers'

const THRESHOLD = '2026-05-17T11:30:00.000Z' // 기준 시각 (now - 30min)

describe('buildRunningOrClause — running 필터 OR 절', () => {
  const clause = buildRunningOrClause(THRESHOLD)

  it('gpu_upload_status=running 조건 포함 (첫 단계 — prevAt 없음, stuck 불가)', () => {
    expect(clause).toContain('gpu_upload_status.eq.running')
  })

  it('stt_status=running 조건에 gpu_uploaded_at.gte 포함 (threshold 이후만)', () => {
    expect(clause).toContain(`and(stt_status.eq.running,or(gpu_uploaded_at.is.null,gpu_uploaded_at.gte.${THRESHOLD}))`)
  })

  it('diarize_status=running 조건에 stt_at.gte 포함', () => {
    expect(clause).toContain(`and(diarize_status.eq.running,or(stt_at.is.null,stt_at.gte.${THRESHOLD}))`)
  })

  it('gpu_pii_status=running 조건에 diarize_at.gte 포함', () => {
    expect(clause).toContain(`and(gpu_pii_status.eq.running,or(diarize_at.is.null,diarize_at.gte.${THRESHOLD}))`)
  })

  it('auto_label_status=running 조건에 gpu_pii_at.gte 포함', () => {
    expect(clause).toContain(`and(auto_label_status.eq.running,or(gpu_pii_at.is.null,gpu_pii_at.gte.${THRESHOLD}))`)
  })

  it('quality_status=running 조건에 label_at.gte 포함', () => {
    expect(clause).toContain(`and(quality_status.eq.running,or(label_at.is.null,label_at.gte.${THRESHOLD}))`)
  })

  it('stuck 세션 조건(lt)은 포함하지 않음 — running 필터는 stuck 제외', () => {
    expect(clause).not.toContain('.lt.')
  })

  it('prevAt NULL 허용 — null인 세션은 running으로 분류', () => {
    expect(clause).toContain('gpu_uploaded_at.is.null')
    expect(clause).toContain('stt_at.is.null')
    expect(clause).toContain('diarize_at.is.null')
    expect(clause).toContain('gpu_pii_at.is.null')
    expect(clause).toContain('label_at.is.null')
  })

  it('threshold 값이 OR 절에 반영됨', () => {
    const clause2 = buildRunningOrClause('2026-01-01T00:00:00.000Z')
    expect(clause2).toContain('2026-01-01T00:00:00.000Z')
    expect(clause2).not.toContain(THRESHOLD)
  })
})

describe('distinctSessionIds — PII 후보 세션 ID 중복 제거', () => {
  it('중복 session_id 를 제거한다', () => {
    const rows = [{ session_id: 's1' }, { session_id: 's1' }, { session_id: 's2' }]
    expect(distinctSessionIds(rows).sort()).toEqual(['s1', 's2'])
  })

  it('빈 입력은 빈 배열 (회귀: 후보 0 → 0건)', () => {
    expect(distinctSessionIds([])).toEqual([])
    expect(distinctSessionIds(null)).toEqual([])
    expect(distinctSessionIds(undefined)).toEqual([])
  })
})

describe('countCandidatesBySession — 세션별 PII 후보 수', () => {
  it('session_id 별로 후보 수를 집계한다', () => {
    const rows = [{ session_id: 's1' }, { session_id: 's1' }, { session_id: 's2' }]
    const m = countCandidatesBySession(rows)
    expect(m.get('s1')).toBe(2)
    expect(m.get('s2')).toBe(1)
  })

  it('빈 입력은 빈 맵', () => {
    expect(countCandidatesBySession([]).size).toBe(0)
    expect(countCandidatesBySession(null).size).toBe(0)
  })
})
