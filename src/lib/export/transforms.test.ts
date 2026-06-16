import { describe, it, expect } from 'vitest'
import {
  sanitizeExternalMethod,
  sanitizeExternalLabelOrigin,
  sanitizeExternalSpeakerRole,
  mapSessionSpeakerRoleToCandidate,
  dialogActToGroup,
} from './transforms.js'

describe('sanitizeExternalMethod (안전선 #6 - 내부 모델명 노출 금지)', () => {
  it('preserves already-allowed values', () => {
    expect(sanitizeExternalMethod('automatic')).toBe('automatic')
    expect(sanitizeExternalMethod('supervised_model')).toBe('supervised_model')
    expect(sanitizeExternalMethod('rule_based_mvp')).toBe('rule_based_mvp')
    expect(sanitizeExternalMethod('heuristic_mvp')).toBe('heuristic_mvp')
    expect(sanitizeExternalMethod('self_declared')).toBe('self_declared')
    expect(sanitizeExternalMethod('not_available')).toBe('not_available')
  })

  it('maps internal model names (aihub_*, kcelectra_*) to supervised_model', () => {
    expect(sanitizeExternalMethod('aihub_emotion_v1')).toBe('supervised_model')
    expect(sanitizeExternalMethod('aihub_dialog_act_v2')).toBe('supervised_model')
    expect(sanitizeExternalMethod('kcelectra_v1')).toBe('supervised_model')
    expect(sanitizeExternalMethod('kr-electra_topic_v1')).toBe('supervised_model')
    expect(sanitizeExternalMethod('snunlp_v1')).toBe('supervised_model')
  })

  it('maps STT/diarization model names to automatic', () => {
    expect(sanitizeExternalMethod('whisperx_large_v3')).toBe('automatic')
    expect(sanitizeExternalMethod('pyannote_v3')).toBe('automatic')
    expect(sanitizeExternalMethod('wespeaker_v1')).toBe('automatic')
  })

  it('maps rule_* and heuristic_* prefixes', () => {
    expect(sanitizeExternalMethod('rule_v1')).toBe('rule_based_mvp')
    expect(sanitizeExternalMethod('heuristic_v1')).toBe('heuristic_mvp')
  })

  it('returns not_available for unknown/empty input', () => {
    expect(sanitizeExternalMethod('')).toBe('not_available')
    expect(sanitizeExternalMethod(null)).toBe('not_available')
    expect(sanitizeExternalMethod(undefined)).toBe('not_available')
    expect(sanitizeExternalMethod('random_value')).toBe('not_available')
    expect(sanitizeExternalMethod(123)).toBe('not_available')
  })

  it('NEVER returns a value containing internal model name literals', () => {
    const inputs = [
      'aihub_emotion_v1',
      'AIHUB_topic_v2',
      'kcelectra_v1',
      'KcELECTRA_v2',
      'whisperx_large_v3',
      'WhisperX_v3',
      'pyannote_segmentation_v3',
    ]
    const forbidden = ['aihub', 'kcelectra', 'kc-electra', 'kr-electra', 'whisperx', 'pyannote', 'wespeaker']
    for (const input of inputs) {
      const result = sanitizeExternalMethod(input)
      const lower = result.toLowerCase()
      for (const banned of forbidden) {
        expect(lower).not.toContain(banned)
      }
    }
  })
})

describe('sanitizeExternalLabelOrigin (delegates to sanitizeExternalMethod, 안전선 #6)', () => {
  it('returns the 5-method allowlist (not a separate provenance enum)', () => {
    expect(sanitizeExternalLabelOrigin('automatic')).toBe('automatic')
    expect(sanitizeExternalLabelOrigin('supervised_model')).toBe('supervised_model')
    expect(sanitizeExternalLabelOrigin('rule_based_mvp')).toBe('rule_based_mvp')
    expect(sanitizeExternalLabelOrigin('heuristic_mvp')).toBe('heuristic_mvp')
    expect(sanitizeExternalLabelOrigin('not_available')).toBe('not_available')
  })

  it('generalizes internal model names to supervised_model (안전선 #6)', () => {
    expect(sanitizeExternalLabelOrigin('aihub_emotion_v1')).toBe('supervised_model')
    expect(sanitizeExternalLabelOrigin('kcelectra_v1')).toBe('supervised_model')
  })

  it('generalizes STT/diarization to automatic', () => {
    expect(sanitizeExternalLabelOrigin('whisperx_large_v3')).toBe('automatic')
    expect(sanitizeExternalLabelOrigin('pyannote_v3')).toBe('automatic')
  })

  it('returns not_available for empty / null / unrecognized', () => {
    expect(sanitizeExternalLabelOrigin('')).toBe('not_available')
    expect(sanitizeExternalLabelOrigin(null)).toBe('not_available')
    expect(sanitizeExternalLabelOrigin(undefined)).toBe('not_available')
    expect(sanitizeExternalLabelOrigin('random_value')).toBe('not_available')
  })
})

describe('sanitizeExternalSpeakerRole (안전선 #1 - 확정값 금지)', () => {
  it('maps DB confirmed values (owner/counterparty) to _candidate form', () => {
    expect(sanitizeExternalSpeakerRole('owner')).toBe('owner_candidate')
    expect(sanitizeExternalSpeakerRole('counterparty')).toBe('counterparty_candidate')
  })

  it('preserves already-candidate values', () => {
    expect(sanitizeExternalSpeakerRole('owner_candidate')).toBe('owner_candidate')
    expect(sanitizeExternalSpeakerRole('counterparty_candidate')).toBe('counterparty_candidate')
  })

  it('returns unknown for self/other/peer (확정 표현 금지)', () => {
    // 안전선 #1: 내부 self/other 가 외부에 owner/counterparty 형태로 노출되지 않도록
    // 명시적 owner/counterparty (DB 확정) 외에는 모두 unknown.
    expect(sanitizeExternalSpeakerRole('self')).toBe('unknown')
    expect(sanitizeExternalSpeakerRole('other')).toBe('unknown')
    expect(sanitizeExternalSpeakerRole('peer')).toBe('unknown')
  })

  it('returns unknown for empty / null / non-string', () => {
    expect(sanitizeExternalSpeakerRole('unknown')).toBe('unknown')
    expect(sanitizeExternalSpeakerRole('')).toBe('unknown')
    expect(sanitizeExternalSpeakerRole(null)).toBe('unknown')
    expect(sanitizeExternalSpeakerRole(undefined)).toBe('unknown')
    expect(sanitizeExternalSpeakerRole(42)).toBe('unknown')
  })

  it('NEVER emits raw confirmed terms (only candidate / unknown)', () => {
    const inputs = ['owner', 'counterparty', 'self', 'other', 'peer', 'unknown', '', null]
    for (const input of inputs) {
      const result = sanitizeExternalSpeakerRole(input)
      expect(result).toMatch(/^(owner_candidate|counterparty_candidate|unknown)$/)
    }
  })
})

describe('mapSessionSpeakerRoleToCandidate (DB self/other → candidate, 안전선 #1)', () => {
  it('maps heuristic self/other to candidate form', () => {
    expect(mapSessionSpeakerRoleToCandidate('self')).toBe('owner_candidate')
    expect(mapSessionSpeakerRoleToCandidate('other')).toBe('counterparty_candidate')
  })

  it('case-insensitive / trimmed', () => {
    expect(mapSessionSpeakerRoleToCandidate(' SELF ')).toBe('owner_candidate')
    expect(mapSessionSpeakerRoleToCandidate('Other')).toBe('counterparty_candidate')
  })

  it('owner/counterparty (이미 candidate 의미) 도 동일 candidate', () => {
    expect(mapSessionSpeakerRoleToCandidate('owner')).toBe('owner_candidate')
    expect(mapSessionSpeakerRoleToCandidate('counterparty')).toBe('counterparty_candidate')
  })

  it('null/peer/empty/비문자열 → unknown', () => {
    expect(mapSessionSpeakerRoleToCandidate(null)).toBe('unknown')
    expect(mapSessionSpeakerRoleToCandidate('peer')).toBe('unknown')
    expect(mapSessionSpeakerRoleToCandidate('')).toBe('unknown')
    expect(mapSessionSpeakerRoleToCandidate(42)).toBe('unknown')
  })

  it('NEVER emits raw self/other/owner/counterparty (only candidate / unknown)', () => {
    const inputs = ['self', 'other', 'owner', 'counterparty', 'peer', null, '']
    for (const input of inputs) {
      const result = mapSessionSpeakerRoleToCandidate(input)
      expect(result).toMatch(/^(owner_candidate|counterparty_candidate|unknown)$/)
    }
  })
})

describe('dialogActToGroup (SPEC §5.1.4 DIALOG_ACT_TO_GROUP_v1)', () => {
  it('maps Korean dialog_act values to group categories', () => {
    expect(dialogActToGroup('진술')).toBe('정보')
    expect(dialogActToGroup('질문')).toBe('질문/확인')
    expect(dialogActToGroup('확인')).toBe('질문/확인')
    expect(dialogActToGroup('요청')).toBe('요청/제안')
    expect(dialogActToGroup('제안')).toBe('요청/제안')
    expect(dialogActToGroup('감사')).toBe('감사/사과')
    expect(dialogActToGroup('사과')).toBe('감사/사과')
    expect(dialogActToGroup('인사')).toBe('사회적')
    expect(dialogActToGroup('동의')).toBe('응답')
    expect(dialogActToGroup('반대')).toBe('응답')
    expect(dialogActToGroup('부정')).toBe('응답')
    expect(dialogActToGroup('응답')).toBe('응답')
    expect(dialogActToGroup('명령')).toBe('지시')
    expect(dialogActToGroup('감탄')).toBe('감정 표현')
    expect(dialogActToGroup('기타')).toBe('기타')
  })

  it('returns null for unmapped / empty / non-string', () => {
    expect(dialogActToGroup('미정의값')).toBeNull()
    expect(dialogActToGroup('')).toBeNull()
    expect(dialogActToGroup(null)).toBeNull()
    expect(dialogActToGroup(undefined)).toBeNull()
    expect(dialogActToGroup(123)).toBeNull()
  })
})
