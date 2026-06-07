/**
 * relationGeneralization — 화자 관계 K-익명성(K=5) 게이트 + 일반화 tier 단위 테스트.
 *
 * 검증:
 *   - 흔한값(count>=5) → 원문 노출.
 *   - 희귀값(count<5) → 일반화 tier (tier 합산 count>=5 일 때만).
 *   - tier 합산도 희귀 → null.
 *   - map 밖 미지값: K 충족 시 원문, 미충족 시 null.
 *   - 관계 부재/공백 → null.
 *   - 데이터셋 빈도표 집계.
 */

import { describe, it, expect } from 'vitest'
import {
  K_ANONYMITY_THRESHOLD,
  RELATION_GENERALIZATION_MAP,
  generalizeRelation,
  resolveRelationCandidate,
  buildRelationFrequency,
} from './relationGeneralization.js'

describe('K_ANONYMITY_THRESHOLD', () => {
  it('K=5 (디렉터 승인 정책)', () => {
    expect(K_ANONYMITY_THRESHOLD).toBe(5)
  })
})

describe('generalizeRelation — tier map', () => {
  it('교사/교수/강사 → 교육관계자', () => {
    expect(generalizeRelation('교사')).toBe('교육관계자')
    expect(generalizeRelation('교수')).toBe('교육관계자')
    expect(generalizeRelation('강사')).toBe('교육관계자')
  })
  it('부모/자녀/형제자매/배우자 → 가족', () => {
    for (const r of ['부모', '자녀', '형제자매', '배우자']) {
      expect(generalizeRelation(r)).toBe('가족')
    }
  })
  it('직장동료/직장상사 → 직장관계', () => {
    expect(generalizeRelation('직장동료')).toBe('직장관계')
    expect(generalizeRelation('직장상사')).toBe('직장관계')
  })
  it('거래처/고객 → 거래관계', () => {
    expect(generalizeRelation('거래처')).toBe('거래관계')
    expect(generalizeRelation('고객')).toBe('거래관계')
  })
  it('친구 → 지인', () => {
    expect(generalizeRelation('친구')).toBe('지인')
  })
  it('map 에 없는 미지값 → null', () => {
    expect(generalizeRelation('외계인')).toBeNull()
    expect(generalizeRelation('')).toBeNull()
  })
})

describe('resolveRelationCandidate — K 게이트', () => {
  it('흔한값(count>=5) → 원문, generalized:false', () => {
    const counts = new Map([['교사', 23]])
    const rc = resolveRelationCandidate('교사', counts)
    expect(rc).not.toBeNull()
    expect(rc!.value).toBe('교사')
    expect(rc!.generalized).toBe(false)
    expect(rc!.method).toBe('heuristic_mvp')
    expect(rc!.disclaimer).toContain('probabilistic')
  })

  it('경계값 count=5 → 원문 노출 (>= 임계)', () => {
    const rc = resolveRelationCandidate('교사', new Map([['교사', 5]]))
    expect(rc!.value).toBe('교사')
    expect(rc!.generalized).toBe(false)
  })

  it('count=4 → 일반화 tier 시도 (< 임계)', () => {
    // 교사4 + 교수3 = 교육관계자 7 (>=5) → 일반화 노출.
    const counts = new Map([['교사', 4], ['교수', 3]])
    const rc = resolveRelationCandidate('교사', counts)
    expect(rc!.value).toBe('교육관계자')
    expect(rc!.generalized).toBe(true)
  })

  it('희귀값 + tier 합산도 희귀 → null', () => {
    const rc = resolveRelationCandidate('교사', new Map([['교사', 2]]))
    expect(rc).toBeNull()
  })

  it('희귀값이지만 tier 합산이 K 충족 → 일반화 노출', () => {
    // 자녀2 + 부모4 = 가족 6 (>=5) → 자녀는 가족으로 일반화.
    const counts = new Map([['자녀', 2], ['부모', 4]])
    const rc = resolveRelationCandidate('자녀', counts)
    expect(rc!.value).toBe('가족')
    expect(rc!.generalized).toBe(true)
  })

  it('관계 부재(null/undefined/공백) → null', () => {
    const counts = new Map([['교사', 23]])
    expect(resolveRelationCandidate(null, counts)).toBeNull()
    expect(resolveRelationCandidate(undefined, counts)).toBeNull()
    expect(resolveRelationCandidate('   ', counts)).toBeNull()
  })

  it('map 밖 미지값: K 충족 → 원문 노출', () => {
    const rc = resolveRelationCandidate('외계인', new Map([['외계인', 9]]))
    expect(rc!.value).toBe('외계인')
    expect(rc!.generalized).toBe(false)
  })

  it('map 밖 미지값: K 미충족 → null (일반화 불가)', () => {
    expect(resolveRelationCandidate('외계인', new Map([['외계인', 3]]))).toBeNull()
  })

  it('빈도표 미주입(빈 맵): 흔한값도 count=0 → null', () => {
    expect(resolveRelationCandidate('교사', new Map())).toBeNull()
  })
})

describe('resolveRelationCandidate — 실측 분포(전체 375 non-null) 회귀', () => {
  // 2026-06-05 실DB 분포: 전부 K>=5 → 전부 원문 노출.
  const liveCounts = new Map<string, number>([
    ['친구', 84], ['부모', 79], ['고객', 48], ['배우자', 40], ['직장동료', 33],
    ['거래처', 26], ['교사', 23], ['형제자매', 17], ['직장상사', 17], ['자녀', 8],
  ])

  it('실측 모든 관계값이 원문 노출(generalized:false)', () => {
    for (const rel of liveCounts.keys()) {
      const rc = resolveRelationCandidate(rel, liveCounts)
      expect(rc, rel).not.toBeNull()
      expect(rc!.value, rel).toBe(rel)
      expect(rc!.generalized, rel).toBe(false)
    }
  })

  it('교사=23 → 원문 노출 (DoD §2)', () => {
    const rc = resolveRelationCandidate('교사', liveCounts)
    expect(rc!.value).toBe('교사')
    expect(rc!.generalized).toBe(false)
  })
})

describe('buildRelationFrequency', () => {
  it('관계값별 빈도 집계, null/공백 제외', () => {
    const rows = [
      { speaker_relation: '교사' },
      { speaker_relation: '교사' },
      { speaker_relation: '부모' },
      { speaker_relation: null },
      { speaker_relation: '  ' },
      { speaker_relation: undefined },
    ]
    const f = buildRelationFrequency(rows)
    expect(f.get('교사')).toBe(2)
    expect(f.get('부모')).toBe(1)
    expect(f.has('')).toBe(false)
    expect(f.size).toBe(2)
  })

  it('공백 trim 후 동일값 병합', () => {
    const f = buildRelationFrequency([{ speaker_relation: ' 교사 ' }, { speaker_relation: '교사' }])
    expect(f.get('교사')).toBe(2)
  })
})

describe('RELATION_GENERALIZATION_MAP 무결성', () => {
  it('모든 tier 가 4개 범주 중 하나', () => {
    const tiers = new Set(Object.values(RELATION_GENERALIZATION_MAP))
    expect(tiers).toEqual(new Set(['교육관계자', '가족', '직장관계', '거래관계', '지인']))
  })
})
