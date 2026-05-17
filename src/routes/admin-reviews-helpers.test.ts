import { describe, it, expect } from 'vitest'
import { buildRunningOrClause } from './admin-reviews-helpers'

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
