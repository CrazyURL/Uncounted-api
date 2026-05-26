import { describe, it, expect } from 'vitest'
import {
  buildRunningOrClause,
  distinctSessionIds,
  countCandidatesBySession,
  PIPELINE_STATUS_COLUMNS,
  pipelineComplete,
  REVIEW_TRANSITION_SELECT,
  PIPELINE_FAILED_COLUMNS,
  PIPELINE_FAILED_OR,
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

// 회귀: POST /reviews/:id 핸들러의 SELECT 가 auto_label_status 를 빼먹어
// pipelineComplete 가 항상 false → 모든 pending→in_review 가 409 로 거부되던 버그.
// SELECT 문자열과 pipelineComplete 가 읽는 컬럼이 어긋나지 않도록 단일 상수에서 파생시키고,
// 그 불변식을 테스트로 고정한다.
describe('PIPELINE_STATUS_COLUMNS — 파이프라인 단계 컬럼 단일 출처', () => {
  it('6개 단계 컬럼을 모두 포함한다', () => {
    expect([...PIPELINE_STATUS_COLUMNS].sort()).toEqual(
      [
        'auto_label_status',
        'diarize_status',
        'gpu_pii_status',
        'gpu_upload_status',
        'quality_status',
        'stt_status',
      ].sort(),
    )
  })

  it('auto_label_status 를 반드시 포함한다 (버그 핵심 컬럼)', () => {
    expect(PIPELINE_STATUS_COLUMNS).toContain('auto_label_status')
  })
})

describe('REVIEW_TRANSITION_SELECT — 전환 핸들러 SELECT 컬럼', () => {
  it('id, review_status 를 포함한다', () => {
    expect(REVIEW_TRANSITION_SELECT).toContain('id')
    expect(REVIEW_TRANSITION_SELECT).toContain('review_status')
  })

  // 드리프트 가드: pipelineComplete 가 읽는 모든 컬럼이 SELECT 에 있어야 한다.
  for (const col of PIPELINE_STATUS_COLUMNS) {
    it(`pipelineComplete 가 읽는 컬럼 ${col} 을 SELECT 에 포함한다`, () => {
      expect(REVIEW_TRANSITION_SELECT).toContain(col)
    })
  }

  it('auto_label_status 가 SELECT 에 들어있다 (회귀 방지)', () => {
    expect(REVIEW_TRANSITION_SELECT).toContain('auto_label_status')
  })
})

describe('pipelineComplete — 6단계 모두 terminal 일 때만 true', () => {
  const allDone = {
    gpu_upload_status: 'done',
    stt_status: 'done',
    diarize_status: 'done',
    gpu_pii_status: 'done',
    auto_label_status: 'done',
    quality_status: 'done',
  }

  it('6단계 모두 done 이면 true', () => {
    expect(pipelineComplete(allDone)).toBe(true)
  })

  it('skipped 도 terminal 로 인정', () => {
    expect(pipelineComplete({ ...allDone, quality_status: 'skipped' })).toBe(true)
  })

  it('auto_label_status 가 빠진 row(undefined) 는 false — 버그 재현', () => {
    const { auto_label_status, ...withoutAutoLabel } = allDone
    expect(pipelineComplete(withoutAutoLabel)).toBe(false)
  })

  it('한 단계라도 running 이면 false', () => {
    expect(pipelineComplete({ ...allDone, stt_status: 'running' })).toBe(false)
  })
})

// "처리 오류"(pipeline_failed) 판정은 자동 라벨링 단계를 의도적으로 제외한다.
// 자동 라벨링은 학습 고도화 중 graceful skip/fail 이 정상이므로(CLAUDE.md §9/§15)
// 이를 오류로 합산하면 운영자에게 실재하지 않는 "처리 오류"가 노출된다.
// 목록 필터 / duration 합산 / dashboard 카운트가 이 상수를 공유해 표시 드리프트를 막는다.
describe('PIPELINE_FAILED_COLUMNS — 처리 오류 판정 컬럼 단일 출처', () => {
  it('auto_label_status 를 제외한 5개 단계 컬럼만 포함한다', () => {
    expect([...PIPELINE_FAILED_COLUMNS].sort()).toEqual(
      [
        'diarize_status',
        'gpu_pii_status',
        'gpu_upload_status',
        'quality_status',
        'stt_status',
      ].sort(),
    )
  })

  it('auto_label_status 를 포함하지 않는다 (처리 오류 정의의 핵심)', () => {
    expect(PIPELINE_FAILED_COLUMNS).not.toContain('auto_label_status')
  })

  it('PIPELINE_STATUS_COLUMNS 보다 정확히 auto_label_status 하나만 적다', () => {
    expect(PIPELINE_FAILED_COLUMNS.length).toBe(PIPELINE_STATUS_COLUMNS.length - 1)
    const failedSet = new Set<string>(PIPELINE_FAILED_COLUMNS)
    const onlyInStatus = PIPELINE_STATUS_COLUMNS.filter((c) => !failedSet.has(c))
    expect(onlyInStatus).toEqual(['auto_label_status'])
  })
})

describe('PIPELINE_FAILED_OR — supabase .or() 절', () => {
  it('5개 단계 각각 .eq.failed 조건을 포함한다', () => {
    for (const col of PIPELINE_FAILED_COLUMNS) {
      expect(PIPELINE_FAILED_OR).toContain(`${col}.eq.failed`)
    }
  })

  it('auto_label_status.eq.failed 를 포함하지 않는다', () => {
    expect(PIPELINE_FAILED_OR).not.toContain('auto_label_status')
  })

  it('정확히 5개 절을 쉼표로 연결한다', () => {
    expect(PIPELINE_FAILED_OR.split(',')).toHaveLength(5)
  })
})
