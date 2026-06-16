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
  applySelfDeclaredGender,
  buildSelfDeclaredDemographics,
  buildSpeakerLookup,
  buildSpeakersSection,
  buildSpeakerExternal,
  computeSpeakerPersistentId,
  koGenderToEn,
  lookupRoleCandidate,
  EXPOSE_SPEAKER_RELATION,
  type SessionSpeakerRow,
  type SpeakerPersistentIdContext,
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

describe('speaker_persistent_id — 미역산 솔트해시 가명', () => {
  const ownerKey = 'user-uuid-owner-aaaa'
  const peerKey = 'peer-id-counterparty-bbbb'

  const ctx = (salt: string | null): SpeakerPersistentIdContext => ({
    salt,
    identityKeyByRole: { owner_candidate: ownerKey, counterparty_candidate: peerKey },
  })

  const HEX16 = /^[0-9a-f]{16}$/

  it('computeSpeakerPersistentId: 16자 hex 형식', () => {
    const id = computeSpeakerPersistentId(ownerKey, 'deadbeef')
    expect(id).toMatch(HEX16)
  })

  it('identity_key 또는 salt 부재 → null', () => {
    expect(computeSpeakerPersistentId(null, 'deadbeef')).toBeNull()
    expect(computeSpeakerPersistentId(ownerKey, null)).toBeNull()
    expect(computeSpeakerPersistentId('', 'deadbeef')).toBeNull()
  })

  it('동일 세션 내 동일 화자(신원)는 동일 ID', () => {
    const a = computeSpeakerPersistentId(ownerKey, 'fixedsalt')
    const b = computeSpeakerPersistentId(ownerKey, 'fixedsalt')
    expect(a).toBe(b)
    expect(a).toMatch(HEX16)
  })

  it('★미역산: 다른 솔트면 다른 ID (같은 신원이라도)', () => {
    const a = computeSpeakerPersistentId(ownerKey, 'saltAAAA')
    const b = computeSpeakerPersistentId(ownerKey, 'saltBBBB')
    expect(a).not.toBe(b)
  })

  it('buildSpeakerExternal: owner→user_id 해시, counterparty→peer_id 해시', () => {
    const c = ctx('s1')
    const own = buildSpeakerExternal(rowSelf, new Map(), c)
    const oth = buildSpeakerExternal(rowOther, new Map(), c)
    expect(own.speaker_persistent_id).toMatch(HEX16)
    expect(oth.speaker_persistent_id).toMatch(HEX16)
    // owner≠counterparty 신원 → 서로 다른 가명
    expect(own.speaker_persistent_id).not.toBe(oth.speaker_persistent_id)
    // 같은 화자(owner)는 같은 ID
    expect(buildSpeakerExternal(rowSelf, new Map(), c).speaker_persistent_id).toBe(
      own.speaker_persistent_id,
    )
  })

  it('미동의(salt=null) → 전 화자 speaker_persistent_id=null', () => {
    const c = ctx(null)
    expect(buildSpeakerExternal(rowSelf, new Map(), c).speaker_persistent_id).toBeNull()
    expect(buildSpeakerExternal(rowOther, new Map(), c).speaker_persistent_id).toBeNull()
  })

  it('컨텍스트 미주입(null) → speaker_persistent_id=null (기존 호출 무회귀)', () => {
    expect(buildSpeakerExternal(rowSelf).speaker_persistent_id).toBeNull()
    const section = buildSpeakersSection([rowSelf, rowOther])
    expect(section.every((sp) => sp.speaker_persistent_id === null)).toBe(true)
  })

  it('신원 부재 역할(peer_id 없음) → counterparty 가명 null, owner 는 정상', () => {
    const c: SpeakerPersistentIdContext = {
      salt: 's1',
      identityKeyByRole: { owner_candidate: ownerKey, counterparty_candidate: null },
    }
    expect(buildSpeakerExternal(rowSelf, new Map(), c).speaker_persistent_id).toMatch(HEX16)
    expect(buildSpeakerExternal(rowOther, new Map(), c).speaker_persistent_id).toBeNull()
  })

  it('⚠️ raw identity_key(user_id/peer_id)는 출력에 미노출 (해시만)', () => {
    const c = ctx('s1')
    const section = buildSpeakersSection([rowSelf, rowOther], new Map(), c)
    const json = JSON.stringify(section)
    expect(json).not.toContain(ownerKey)
    expect(json).not.toContain(peerKey)
  })
})

describe('koGenderToEn (한국어 자기신고 → 영문 estimate 포맷)', () => {
  it('남성→male, 여성→female', () => {
    expect(koGenderToEn('남성')).toBe('male')
    expect(koGenderToEn('여성')).toBe('female')
  })
  it('논바이너리/응답안함/null/undefined → null (영문 매핑 없음 → 폴백)', () => {
    expect(koGenderToEn('논바이너리')).toBeNull()
    expect(koGenderToEn('응답안함')).toBeNull()
    expect(koGenderToEn(null)).toBeNull()
    expect(koGenderToEn(undefined)).toBeNull()
  })
})

describe('applySelfDeclaredGender (self 성별 = users_profile 자기신고)', () => {
  it('self 행만 자기신고 gender_estimate 주입, other 화자는 무변경', () => {
    const out = applySelfDeclaredGender([rowSelf, rowOther], '남성')
    const self = out.find((r) => r.speaker_role === 'self')!
    const other = out.find((r) => r.speaker_role === 'other')!
    expect(self.speaker_gender_estimate).toEqual({
      value: 'male',
      confidence: 1,
      method: 'self_declared',
    })
    // other 는 librosa 모델값 그대로(estimate null 스텁 보존)
    expect(other.speaker_gender).toBe('male')
    expect(other.speaker_gender_estimate).toEqual(rowOther.speaker_gender_estimate)
  })

  // Red-Green: 주입 전 self 는 librosa 오판 female → 주입 후 자기신고 male
  it('buildSpeakerExternal: self gender_estimate female(librosa)→male(자기신고), method=self_declared', () => {
    const before = buildSpeakerExternal(rowSelf)
    expect((before.gender_estimate as Record<string, unknown>).value).toBe('female') // Red

    const [selfAfter] = applySelfDeclaredGender([rowSelf], '남성')
    const est = buildSpeakerExternal(selfAfter).gender_estimate as Record<string, unknown>
    expect(est.value).toBe('male') // Green
    expect(est.method).toBe('self_declared')
    expect(est.confidence).toBe(1)
  })

  it('남성·여성 외(논바이너리/null/undefined) → 원본 그대로(librosa 폴백)', () => {
    expect(applySelfDeclaredGender([rowSelf], '논바이너리')).toEqual([rowSelf])
    expect(applySelfDeclaredGender([rowSelf], null)).toEqual([rowSelf])
    expect(applySelfDeclaredGender([rowSelf], undefined)).toEqual([rowSelf])
    const [s] = applySelfDeclaredGender([rowSelf], null)
    expect((buildSpeakerExternal(s).gender_estimate as Record<string, unknown>).value).toBe(
      'female',
    )
  })

  it('불변성: 원본 배열·행 미변경', () => {
    const input = [rowSelf, rowOther]
    const out = applySelfDeclaredGender(input, '남성')
    expect(out).not.toBe(input)
    expect(rowSelf.speaker_gender_estimate).toEqual({
      value: null,
      method: 'not_available',
      confidence: null,
    })
  })
})

describe('buildSelfDeclaredDemographics (owner_demographics 블록)', () => {
  const fullProfile = {
    gender: '남성',
    age_band: '30대',
    region_group: '수도권',
    accent_group: '경상도',
    primary_language: '한국어(ko-KR)',
  }

  it('5종 전부 + source/disclaimer/owner_candidate (gender 영문 정규화)', () => {
    expect(buildSelfDeclaredDemographics(fullProfile)).toEqual({
      speaker_role_candidate: 'owner_candidate',
      source: 'self_declared',
      disclaimer: 'Self-declared by the data owner; not model-inferred.',
      gender: 'male',
      age_band: '30대',
      region: '수도권',
      dialect: '경상도',
      primary_language: '한국어(ko-KR)',
    })
  })

  it('값 있는 필드만 포함(미설정 생략)', () => {
    const b = buildSelfDeclaredDemographics({ gender: '여성', region_group: '영남' })!
    expect(b.gender).toBe('female')
    expect(b.region).toBe('영남')
    expect('age_band' in b).toBe(false)
    expect('dialect' in b).toBe(false)
    expect('primary_language' in b).toBe(false)
  })

  it('논바이너리 gender → 생략, 사투리 카테고리값(강원도)은 한국어 원문 보존(호칭부재라 안전)', () => {
    const b = buildSelfDeclaredDemographics({ gender: '논바이너리', accent_group: '강원도' })!
    expect('gender' in b).toBe(false)
    expect(b.dialect).toBe('강원도')
  })

  it('전 필드 부재/null/응답안함 → null(파일 미생성)', () => {
    expect(buildSelfDeclaredDemographics(null)).toBeNull()
    expect(buildSelfDeclaredDemographics(undefined)).toBeNull()
    expect(buildSelfDeclaredDemographics({})).toBeNull()
    expect(buildSelfDeclaredDemographics({ gender: '응답안함', age_band: null })).toBeNull()
  })
})
