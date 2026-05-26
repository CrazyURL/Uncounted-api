import { describe, it, expect } from 'vitest'
import { PIPELINE_FAILED_STAGES, PIPELINE_FAILED_OR_CLAUSE } from './pipelineStatus.js'

describe('PIPELINE_FAILED — 처리 오류 판정 기준 (단일 소스)', () => {
  it('대시보드 카운트가 쓰는 5개 단계만 포함한다', () => {
    expect(PIPELINE_FAILED_STAGES).toEqual([
      'gpu_upload_status',
      'stt_status',
      'diarize_status',
      'gpu_pii_status',
      'quality_status',
    ])
  })

  it('auto_label_status 는 처리 오류 기준에서 제외한다 (재학습 중 양성 failed)', () => {
    expect(PIPELINE_FAILED_STAGES).not.toContain('auto_label_status')
    expect(PIPELINE_FAILED_OR_CLAUSE).not.toContain('auto_label_status')
  })

  it('supabase-js .or() 절 형식 — 각 단계 ".eq.failed" 를 쉼표로 연결', () => {
    expect(PIPELINE_FAILED_OR_CLAUSE).toBe(
      'gpu_upload_status.eq.failed,stt_status.eq.failed,diarize_status.eq.failed,gpu_pii_status.eq.failed,quality_status.eq.failed',
    )
  })
})
