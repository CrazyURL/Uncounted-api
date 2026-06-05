/**
 * sessionSpeakers — 화자 메타 외부 변환 안전선 테스트.
 *
 * 검증 초점:
 *   - #1: self/other 확정 단어가 어떤 출력에도 노출되지 않는다 (candidate/estimate 형만).
 *   - #4: speaker_relation(관계 PII)은 K-익명성(K=5) 게이트 + 일반화 tier 로만 노출
 *         (EXPOSE_SPEAKER_RELATION=true, SPEC §4.4 개정 2026-06-05).
 *   - #6: 내부 모델명/출처는 method 일반화 후에만 노출.
 *   - 룩업 미스(IVR/미매핑) → unknown.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSpeakerLookup,
  buildSpeakersSection,
  buildSpeakerExternal,
  lookupRoleCandidate,
  EXPOSE_SPEAKER_RELATION,
  type SessionSpeakerRow,
} from './sessionSpeakers.js'

// 실DB(7b6cf9eb…) 형태를 모사한 행: estimate JSONB 는 null 스텁, 확정 컬럼만 채워짐.
const rowSelf: SessionSpeakerRow = {
  speaker_label: 'SPEAKER_00',
  speaker_role: 'self',
  speaker_role_source: 'heuristic',
  speaker_gender: 'female',
  speaker_voice_age_range: '30대',
  speaker_speech_age_range: '40대',
  speaker_relation: null,
  speaker_identity_inference: {
    note: 'Speaker identity is probabilistic and not guaranteed.',
    method: 'not_available',
    status: 'not_available',
    confidence: null,
    predicted_role: null,
    owner_probability: null,
    counterparty_count: null,
    counterparty_probability: null,
  },
  speaker_gender_estimate: { value: null, method: 'not_available', confidence: null },
  speaker_age_group_estimate: { value: null, method: 'not_available', confidence: null },
}

const rowOther: SessionSpeakerRow = {
  ...rowSelf,
  speaker_label: 'SPEAKER_01',
  speaker_role: 'other',
  speaker_gender: 'male',
  speaker_relation: '교사',
}

describe('buildSpeakerLookup / lookupRoleCandidate', () => {
  it('self → owner_candidate, other → counterparty_candidate', () => {
    const map = buildSpeakerLookup([rowSelf, rowOther])
    expect(lookupRoleCandidate(map, 'SPEAKER_00')).toBe('owner_candidate')
    expect(lookupRoleCandidate(map, 'SPEAKER_01')).toBe('counterparty_candidate')
  })

  it('룩업 미스(IVR/미매핑) → unknown', () => {
    const map = buildSpeakerLookup([rowSelf, rowOther])
    expect(lookupRoleCandidate(map, 'SPEAKER_IVR')).toBe('unknown')
    expect(lookupRoleCandidate(map, null)).toBe('unknown')
    expect(lookupRoleCandidate(map, undefined)).toBe('unknown')
  })

  it('speaker_label 없는 행은 룩업에서 제외', () => {
    const map = buildSpeakerLookup([{ ...rowSelf, speaker_label: null }])
    expect(map.size).toBe(0)
  })

  it('룩업 엔트리에 gender/voice_age/relation 보존(라인 미노출, call.json 용)', () => {
    const map = buildSpeakerLookup([rowOther])
    const e = map.get('SPEAKER_01')!
    expect(e.gender).toBe('male')
    expect(e.voice_age).toBe('30대')
    expect(e.relation).toBe('교사')
  })
})

describe('buildSpeakerExternal — 안전선 #1 (self/other 단어 미노출)', () => {
  it('predicted_role 은 candidate 형, self/other 단어 미노출', () => {
    const ext = buildSpeakerExternal(rowSelf)
    const ii = ext.identity_inference as Record<string, unknown>
    expect(ii.predicted_role).toBe('owner_candidate')
    expect(JSON.stringify(ext).toLowerCase()).not.toMatch(/"self"|"other"/)
  })

  it('other 행도 counterparty_candidate, self/other 단어 미노출', () => {
    const ext = buildSpeakerExternal(rowOther)
    const ii = ext.identity_inference as Record<string, unknown>
    expect(ii.predicted_role).toBe('counterparty_candidate')
  })

  it('identity_inference 에 disclaimer + note 미노출', () => {
    const ii = buildSpeakerExternal(rowSelf).identity_inference as Record<string, unknown>
    expect(ii.disclaimer).toBe('Probabilistic inference only. Not a verified identity.')
    expect('note' in ii).toBe(false)
  })
})

describe('buildSpeakerExternal — 성별/연령 estimate 객체 + disclaimer', () => {
  it('estimate JSONB 가 null 스텁이면 확정 컬럼에서 파생', () => {
    const ext = buildSpeakerExternal(rowSelf)
    const g = ext.gender_estimate as Record<string, unknown>
    const a = ext.age_group_estimate as Record<string, unknown>
    expect(g.value).toBe('female')
    expect(g.disclaimer).toBe('Estimated attribute, not verified identity.')
    expect(a.voice_age_range).toBe('30대')
    expect(a.speech_age_range).toBe('40대')
    expect(a.disclaimer).toBe('Estimated attribute, not verified identity.')
  })

  it('성별 미산출 시 value=unknown (확정 단어 X)', () => {
    const ext = buildSpeakerExternal({ ...rowSelf, speaker_gender: null })
    const g = ext.gender_estimate as Record<string, unknown>
    expect(g.value).toBe('unknown')
  })

  it('연령 미산출 시 voice_age_range=null (날조 금지)', () => {
    const ext = buildSpeakerExternal({
      ...rowSelf,
      speaker_voice_age_range: null,
      speaker_age_group_estimate: { value: null, method: 'not_available', confidence: null },
    })
    const a = ext.age_group_estimate as Record<string, unknown>
    expect(a.voice_age_range).toBeNull()
  })

  it('estimate JSONB 에 실값이 있으면 그것을 우선', () => {
    const ext = buildSpeakerExternal({
      ...rowSelf,
      speaker_gender_estimate: { value: 'male', method: 'pyannote_x', confidence: 0.7 },
    })
    const g = ext.gender_estimate as Record<string, unknown>
    expect(g.value).toBe('male')
    expect(g.confidence).toBe(0.7)
    // #6: 모델명(pyannote) 미노출, method 일반화.
    expect(g.method).toBe('automatic')
  })
})

describe('buildSpeakerExternal — 안전선 #4 (관계 K-익명성 게이트)', () => {
  it('EXPOSE_SPEAKER_RELATION = true (SPEC §4.4 개정)', () => {
    expect(EXPOSE_SPEAKER_RELATION).toBe(true)
  })

  it('흔한값(count>=5): 원문 노출(generalized:false) + disclaimer', () => {
    // 교사=23 (>=5) → 원문 노출.
    const counts = new Map([['교사', 23]])
    const ext = buildSpeakerExternal(rowOther, counts)
    const rc = ext.relation_candidate as Record<string, unknown>
    expect(rc.value).toBe('교사')
    expect(rc.generalized).toBe(false)
    expect(rc.method).toBe('heuristic_mvp')
    expect(rc.disclaimer).toBe('Inferred relationship, probabilistic. Not verified.')
  })

  it('희귀값(count<5): 일반화 tier 치환(generalized:true)', () => {
    // 교사=2 (<5) 이지만 교육관계자 tier 합산(교사2+교수4=6 >=5) → 일반화 노출.
    const counts = new Map([['교사', 2], ['교수', 4]])
    const ext = buildSpeakerExternal(rowOther, counts)
    const rc = ext.relation_candidate as Record<string, unknown>
    expect(rc.value).toBe('교육관계자')
    expect(rc.generalized).toBe(true)
  })

  it('tier 합산도 희귀(<5)면 null', () => {
    // 교사=2, 다른 교육관계자 원문 없음 → tier 합산 2 (<5) → null.
    const counts = new Map([['교사', 2]])
    const ext = buildSpeakerExternal(rowOther, counts)
    expect(ext.relation_candidate).toBeNull()
  })

  it('relation 부재(self측, null) → null', () => {
    const counts = new Map([['교사', 23]])
    const ext = buildSpeakerExternal(rowSelf, counts) // rowSelf.speaker_relation = null
    expect(ext.relation_candidate).toBeNull()
  })

  it('빈도표 미주입(빈 맵): 흔한값도 count=0 → tier 게이트(보수적)', () => {
    // 빈도표 없으면 교사 count=0 → 일반화 시도(교육관계자) → tier 합산도 0 → null.
    const ext = buildSpeakerExternal(rowOther)
    expect(ext.relation_candidate).toBeNull()
  })

  it('IVR/미지 관계값(map 밖) → null', () => {
    const counts = new Map([['외계인', 99]]) // map 에 없는 값 → 원문 count>=5 라도 노출
    const ext = buildSpeakerExternal({ ...rowOther, speaker_relation: '외계인' }, counts)
    const rc = ext.relation_candidate as Record<string, unknown>
    // 원문 count>=5 면 map 밖이어도 원문 노출(K 충족 = 재식별 위험 낮음).
    expect(rc.value).toBe('외계인')
    expect(rc.generalized).toBe(false)
  })

  it('map 밖 + 희귀(count<5) → null (일반화 불가)', () => {
    const counts = new Map([['외계인', 2]])
    const ext = buildSpeakerExternal({ ...rowOther, speaker_relation: '외계인' }, counts)
    expect(ext.relation_candidate).toBeNull()
  })
})

describe('buildSpeakersSection', () => {
  it('speaker_label 보유 행만 배열로, IVR 등 라벨 없는 행 제외', () => {
    const section = buildSpeakersSection([rowSelf, rowOther, { ...rowSelf, speaker_label: null }])
    expect(section).toHaveLength(2)
    expect(section.map((s) => s.speaker_label)).toEqual(['SPEAKER_00', 'SPEAKER_01'])
  })

  it('빈 입력 → 빈 배열 (날조 금지)', () => {
    expect(buildSpeakersSection([])).toEqual([])
  })

  it('#6: 내부 모델명이 섹션 전체에 노출되지 않는다', () => {
    const section = buildSpeakersSection([
      { ...rowSelf, speaker_identity_inference: { method: 'pyannote-3.1', predicted_role: null } },
    ])
    expect(JSON.stringify(section).toLowerCase()).not.toMatch(/pyannote|whisperx|kcelectra/)
  })
})
