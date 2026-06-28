import { describe, it, expect } from 'vitest'
import { buildPeerConfirmUpdate, mapQueueRow, normalizeGenderKo } from './peerConfirm.js'

const NOW = '2026-06-26T00:00:00.000Z'
const ADMIN = 'admin-uid-1'

describe('normalizeGenderKo (한국어 canonical + 구 영문 수용)', () => {
  it('한국어 그대로 통과', () => {
    expect(normalizeGenderKo('남성')).toBe('남성')
    expect(normalizeGenderKo('여성')).toBe('여성')
    expect(normalizeGenderKo('논바이너리')).toBe('논바이너리')
  })
  it('구 영문 → 한국어 canonical 정규화', () => {
    expect(normalizeGenderKo('male')).toBe('남성')
    expect(normalizeGenderKo('female')).toBe('여성')
    expect(normalizeGenderKo('non_binary')).toBe('논바이너리')
  })
  it('미인정값/응답안함/null/undefined → null', () => {
    expect(normalizeGenderKo('응답안함')).toBeNull()
    expect(normalizeGenderKo('xyz')).toBeNull()
    expect(normalizeGenderKo(null)).toBeNull()
    expect(normalizeGenderKo(undefined)).toBeNull()
  })
})

describe('buildPeerConfirmUpdate', () => {
  it('전체 속성 확정 → 잠금 + 각 출처 human_locked (gender 한국어 canonical)', () => {
    const r = buildPeerConfirmUpdate(
      {
        relationship: '형제자매',
        attr_category: '가족',
        gender: '남성',
        voice_age_range: '60대이상',
        speech_age_range: '40대',
      },
      ADMIN,
      NOW,
    )
    expect('update' in r).toBe(true)
    const u = (r as { update: Record<string, unknown> }).update
    expect(u.override_locked).toBe(true)
    expect(u.locked_by).toBe(ADMIN)
    expect(u.locked_at).toBe(NOW)
    expect(u.attr_state).toBe('HUMAN_LOCKED')
    expect(u.relationship).toBe('형제자매')
    expect(u.rel_source).toBe('human_locked')
    expect(u.rel_confidence).toBe(1.0)
    expect(u.gender).toBe('남성')
    expect(u.gender_source).toBe('human_locked')
    expect(u.attr_category).toBe('가족')
    expect(u.voice_age_range).toBe('60대이상')
    expect(u.speech_age_range).toBe('40대')
  })

  it('구 영문 gender 입력 → 한국어 canonical 로 정규화 저장', () => {
    const u = (buildPeerConfirmUpdate({ gender: 'female' }, ADMIN, NOW) as { update: Record<string, unknown> }).update
    expect(u.gender).toBe('여성')
    expect(u.gender_source).toBe('human_locked')
  })

  it('빈 body 도 잠금 자체는 유효(상태만 확정, attr 미설정)', () => {
    const u = (buildPeerConfirmUpdate({}, ADMIN, NOW) as { update: Record<string, unknown> }).update
    expect(u.override_locked).toBe(true)
    expect(u.attr_state).toBe('HUMAN_LOCKED')
    expect('relationship' in u).toBe(false)
    expect('gender' in u).toBe(false)
  })

  it('부분 확정(관계만) → 관계+잠금만, 나머지 미설정(보존)', () => {
    const u = (buildPeerConfirmUpdate({ relationship: '직장동료' }, ADMIN, NOW) as { update: Record<string, unknown> }).update
    expect(u.relationship).toBe('직장동료')
    expect(u.rel_source).toBe('human_locked')
    expect('gender' in u).toBe(false)
    expect('attr_category' in u).toBe(false)
  })

  it('enum 위반 → error (relationship/gender/category/age)', () => {
    expect(buildPeerConfirmUpdate({ relationship: '여동생' }, ADMIN, NOW)).toEqual({ error: 'invalid relationship' })
    expect(buildPeerConfirmUpdate({ gender: '응답안함' }, ADMIN, NOW)).toEqual({ error: 'invalid gender' })
    expect(buildPeerConfirmUpdate({ gender: 'xyz' }, ADMIN, NOW)).toEqual({ error: 'invalid gender' })
    expect(buildPeerConfirmUpdate({ attr_category: '친구' }, ADMIN, NOW)).toEqual({ error: 'invalid attr_category' })
    // 앱 정본은 '60대이상' — '60대'(구 버킷)는 무효
    expect(buildPeerConfirmUpdate({ voice_age_range: '60대' }, ADMIN, NOW)).toEqual({ error: 'invalid voice_age_range' })
    expect(buildPeerConfirmUpdate({ voice_age_range: '50대+' }, ADMIN, NOW)).toEqual({ error: 'invalid voice_age_range' })
  })

  it('null 속성은 무시(잠금만), undefined 와 동일', () => {
    const u = (buildPeerConfirmUpdate({ relationship: null, gender: null }, ADMIN, NOW) as { update: Record<string, unknown> }).update
    expect(u.override_locked).toBe(true)
    expect('relationship' in u).toBe(false)
  })
})

describe('mapQueueRow', () => {
  it('call_count → propagation_value + auto_locks_if_confirmed(KPI)', () => {
    const m = mapQueueRow({ id: 'p1', display_name: '상대#abc12345', relationship: '기타', call_count: 265 })
    expect(m.call_count).toBe(265)
    expect(m.propagation_value).toBe(265)
    expect(m.auto_locks_if_confirmed).toBe(265)
    expect(m.display_name).toBe('상대#abc12345')
  })

  it('call_count null → 0, 누락 필드 null', () => {
    const m = mapQueueRow({ id: 'p2' })
    expect(m.call_count).toBe(0)
    expect(m.propagation_value).toBe(0)
    expect(m.relationship).toBeNull()
    expect(m.gender_source).toBeNull()
  })
})

import { buildPeerSelfReportUpdate } from './peerConfirm.js'

describe('buildPeerSelfReportUpdate (상대 자가신고 → peers, peer_stated)', () => {
  const NOW2 = '2026-06-27T00:00:00.000Z'
  it('전체 자가신고 → peer_stated·override_locked·unverified + gender 한국어 + age는 voice_age_range', () => {
    const u = buildPeerSelfReportUpdate(
      { gender: '여성', age_band: '60대이상', region_group: '수도권', accent_group: '경상도', primary_language: '한국어(ko-KR)' },
      NOW2,
    )!
    expect(u.gender).toBe('여성')
    expect(u.voice_age_range).toBe('60대이상')
    expect(u.region_group).toBe('수도권')
    expect(u.accent_group).toBe('경상도')
    expect(u.primary_language).toBe('한국어(ko-KR)')
    expect(u.gender_source).toBe('peer_stated')
    expect(u.override_locked).toBe(true)
    expect(u.attr_state).toBe('peer_stated_unverified')
  })
  it('구 영문 gender → 한국어 canonical 정규화 저장', () => {
    const u = buildPeerSelfReportUpdate({ gender: 'male', age_band: '30대' }, NOW2)!
    expect(u.gender).toBe('남성')
    expect(u.voice_age_range).toBe('30대')
  })
  it('무효 필드는 skip(동의 실패 안 시킴), 유효값만', () => {
    const u = buildPeerSelfReportUpdate({ gender: '남성', age_band: '30대', region_group: 'xxx' }, NOW2)!
    expect(u.gender).toBe('남성') // 한국어 정본 수용
    expect(u.voice_age_range).toBe('30대')
    expect('region_group' in u).toBe(false) // 'xxx' 무효 → skip
    expect(u.override_locked).toBe(true)
  })
  it('유효 자가신고 0개 → null (peers write skip, graceful)', () => {
    expect(buildPeerSelfReportUpdate({}, NOW2)).toBeNull()
    expect(buildPeerSelfReportUpdate({ gender: 'xyz', age_band: '99대' }, NOW2)).toBeNull()
    expect(buildPeerSelfReportUpdate({ gender: null }, NOW2)).toBeNull()
    expect(buildPeerSelfReportUpdate({ gender: '응답안함' }, NOW2)).toBeNull() // 응답안함 미인정 → skip → null
  })
})
