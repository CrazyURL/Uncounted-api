import { describe, it, expect } from 'vitest'
import { buildPreflightSnapshot } from './preflightSnapshot.js'

const utt = (session_id: string, transcript_text: string | null) => ({ session_id, transcript_text })

describe('buildPreflightSnapshot — basic', () => {
  it('empty input → zero counts', () => {
    const r = buildPreflightSnapshot({ utterances: [] })
    expect(r.total_sessions).toBe(0)
    expect(r.total_utterances_scanned).toBe(0)
    expect(r.clean_ratio).toBe(0)
    expect(r.dirty_ratio).toBe(0)
    expect(r.hits_by_category).toEqual({
      credential_like: 0, foreign_id_like: 0, payment_like: 0, korean_name_like: 0, numeric_sensitive_like: 0,
    })
    expect(r.sessions_by_risk_tier).toEqual({ tier_0_clean: 0, tier_1_review: 0, tier_2_blocked: 0 })
    expect(r.top_sessions).toEqual([])
  })

  it('null transcript skipped (utt 카운트는 함)', () => {
    const r = buildPreflightSnapshot({ utterances: [utt('s1', null), utt('s1', null)] })
    expect(r.total_sessions).toBe(1)
    expect(r.total_utterances_scanned).toBe(2)
    expect(r.dirty_utt).toBe(0)
    expect(r.clean_utt).toBe(2)
  })

  it('clean text (no hit) → clean ratio 1.0, tier_0_clean', () => {
    const r = buildPreflightSnapshot({
      utterances: [utt('s1', '오늘은 날씨가 좋다'), utt('s1', '안녕하세요')],
    })
    expect(r.dirty_utt).toBe(0)
    expect(r.clean_ratio).toBe(1)
    expect(r.sessions_by_risk_tier.tier_0_clean).toBe(1)
    expect(r.top_sessions[0].risk_tier).toBe('tier_0_clean')
  })
})

describe('buildPreflightSnapshot — category aggregation', () => {
  it('credential_like hit → tier_2_blocked + 카테고리 count', () => {
    const r = buildPreflightSnapshot({
      utterances: [utt('s1', '비밀번호 Abc1234')],
    })
    expect(r.dirty_utt).toBe(1)
    expect(r.hits_by_category.credential_like).toBeGreaterThan(0)
    expect(r.sessions_by_risk_tier.tier_2_blocked).toBe(1)
    expect(r.top_sessions[0].risk_tier).toBe('tier_2_blocked')
  })

  it('payment_like hit → tier_2_blocked (10+ digits)', () => {
    const r = buildPreflightSnapshot({
      utterances: [utt('s1', '이체 1234567890')],
    })
    expect(r.sessions_by_risk_tier.tier_2_blocked).toBe(1)
    expect(r.hits_by_category.payment_like).toBeGreaterThan(0)
  })

  it('numeric_sensitive_like hit → tier_2_blocked', () => {
    const r = buildPreflightSnapshot({
      utterances: [utt('s1', '코드 987654')],
    })
    expect(r.sessions_by_risk_tier.tier_2_blocked).toBe(1)
    expect(r.hits_by_category.numeric_sensitive_like).toBeGreaterThan(0)
  })

  it('korean_name_like ONLY → tier_1_review', () => {
    const r = buildPreflightSnapshot({
      utterances: [utt('s1', '김민수 씨께서 오셨어요')],
    })
    expect(r.sessions_by_risk_tier.tier_1_review).toBe(1)
    expect(r.hits_by_category.korean_name_like).toBeGreaterThan(0)
    expect(r.sessions_by_risk_tier.tier_2_blocked).toBe(0)
  })

  it('korean_name + credential 동시 → tier_2_blocked (Tier-2 우선)', () => {
    const r = buildPreflightSnapshot({
      utterances: [utt('s1', '김민수 씨께 비밀번호 Abc1234 전달')],
    })
    expect(r.sessions_by_risk_tier.tier_2_blocked).toBe(1)
    expect(r.sessions_by_risk_tier.tier_1_review).toBe(0)
  })

  it('foreign_id_like → tier_2_blocked', () => {
    const r = buildPreflightSnapshot({
      utterances: [utt('s1', '외국인등록증 850515-5876543')],
    })
    expect(r.sessions_by_risk_tier.tier_2_blocked).toBe(1)
    expect(r.hits_by_category.foreign_id_like).toBeGreaterThan(0)
  })
})

describe('buildPreflightSnapshot — multi-session', () => {
  it('3 세션 / 3 tier 분류', () => {
    const r = buildPreflightSnapshot({
      utterances: [
        utt('aaaa1111', '오늘 날씨가 좋다'),       // clean → tier_0
        utt('bbbb2222', '김민수 씨께'),            // korean_name only → tier_1
        utt('cccc3333', '비밀번호 Abc1234'),       // credential → tier_2
      ],
    })
    expect(r.total_sessions).toBe(3)
    expect(r.sessions_by_risk_tier).toEqual({ tier_0_clean: 1, tier_1_review: 1, tier_2_blocked: 1 })
  })

  it('top_sessions 정렬: utt_dirty desc', () => {
    const r = buildPreflightSnapshot({
      utterances: [
        utt('s1', '안녕'),                       // 0 dirty
        utt('s2', '비밀번호 Abc1234'),            // 1 dirty
        utt('s2', '이체 9876543'),                // 1 dirty (s2 total dirty=2)
        utt('s3', '김민수 씨께'),                 // 1 dirty
      ],
    })
    expect(r.top_sessions[0].utt_dirty).toBe(2)
    expect(r.top_sessions[0].id_prefix).toContain('s2')
  })

  it('top_limit 옵션 적용', () => {
    const utts = []
    for (let i = 0; i < 60; i++) {
      utts.push(utt(`s${String(i).padStart(4, '0')}`, '이체 9876543'))
    }
    const r = buildPreflightSnapshot({ utterances: utts }, { topLimit: 10 })
    expect(r.top_sessions.length).toBe(10)
    expect(r.total_sessions).toBe(60)
  })
})

describe('buildPreflightSnapshot — original text leak guard', () => {
  it('top_sessions 항목에 transcript_text / surface / snippet 키 부재', () => {
    const r = buildPreflightSnapshot({
      utterances: [utt('s1', '비밀번호 Abc1234')],
    })
    const row = r.top_sessions[0]
    expect('transcript_text' in row).toBe(false)
    expect('surface' in row).toBe(false)
    expect('snippet' in row).toBe(false)
    expect('text' in row).toBe(false)
    expect('matched' in row).toBe(false)
  })

  it('id_prefix 가 8자 + 말줄임 (full id 노출 0)', () => {
    const r = buildPreflightSnapshot({ utterances: [utt('abcdefghijklmnop12345', '안녕')] })
    expect(r.top_sessions[0].id_prefix).toBe('abcdefgh…')
    expect(r.top_sessions[0].id_prefix).not.toContain('ijklmnop')
  })

  it('hits_by_category 만 emit, matched_text/surface 미포함', () => {
    const r = buildPreflightSnapshot({ utterances: [utt('s1', '비밀번호 Abc1234')] })
    const cats = r.hits_by_category as unknown as Record<string, unknown>
    for (const v of Object.values(cats)) {
      expect(typeof v).toBe('number')
    }
  })
})

describe('buildPreflightSnapshot — Phase A fixture 정합', () => {
  it('clean 10 utt → tier_0 100%', () => {
    const utts = Array.from({ length: 10 }, (_, i) => utt(`s${i}`, `오늘 날씨가 좋다 ${i}`))
    const r = buildPreflightSnapshot({ utterances: utts })
    expect(r.sessions_by_risk_tier.tier_0_clean).toBe(10)
    expect(r.dirty_utt).toBe(0)
  })
})
