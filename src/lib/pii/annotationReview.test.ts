import { describe, it, expect } from 'vitest'
import {
  isValidSource,
  isValidPiiType,
  isValidActionStatus,
  extractSpan,
  normalizeForHash,
  hashNormalized,
  buildManualAnnotationInsert,
  mapPredictedToAnnotationType,
  KOREAN_PII_TYPE_MAP,
  VALID_PII_TYPES,
} from './annotationReview.js'

describe('enum validators', () => {
  it('accepts valid source values', () => {
    expect(isValidSource('detector_candidate')).toBe(true)
    expect(isValidSource('admin_manual')).toBe(true)
    expect(isValidSource('denylist')).toBe(true)
    expect(isValidSource('regex')).toBe(true)
  })

  it('rejects invalid/non-string source', () => {
    expect(isValidSource('unknown')).toBe(false)
    expect(isValidSource('')).toBe(false)
    expect(isValidSource(null)).toBe(false)
    expect(isValidSource(123)).toBe(false)
  })

  it('treats resident_id as a first-class pii_type (not other)', () => {
    expect(isValidPiiType('resident_id')).toBe(true)
    expect(isValidPiiType('name')).toBe(true)
    expect(isValidPiiType('organization')).toBe(true)
    expect(isValidPiiType('주민번호')).toBe(false)
    expect(isValidPiiType('unknown')).toBe(false)
  })

  it('accepts only the four action statuses', () => {
    expect(isValidActionStatus('pending_mask')).toBe(true)
    expect(isValidActionStatus('masked')).toBe(true)
    expect(isValidActionStatus('excluded')).toBe(true)
    expect(isValidActionStatus('revoked')).toBe(true)
    expect(isValidActionStatus('decided')).toBe(false)
    expect(isValidActionStatus(undefined)).toBe(false)
  })
})

describe('extractSpan', () => {
  const text = '안녕하세요 문식환 소장님 전화주세요'

  it('extracts the substring at the given offsets', () => {
    const start = text.indexOf('문식환')
    expect(extractSpan(text, start, start + 3)).toBe('문식환')
  })

  it('clamps out-of-range offsets to text bounds', () => {
    expect(extractSpan(text, -5, 3)).toBe(text.slice(0, 3))
    expect(extractSpan(text, text.length - 2, text.length + 50)).toBe(text.slice(text.length - 2))
  })

  it('returns null for empty text, non-number offsets, or start>=end', () => {
    expect(extractSpan('', 0, 3)).toBeNull()
    expect(extractSpan(null, 0, 3)).toBeNull()
    expect(extractSpan(text, null, 3)).toBeNull()
    expect(extractSpan(text, 5, 5)).toBeNull()
    expect(extractSpan(text, 6, 3)).toBeNull()
  })
})

describe('normalizeForHash / hashNormalized', () => {
  it('NFC-normalizes so decomposed and composed forms match', () => {
    // '문' composed (U+BB38) vs decomposed jamo (U+1106 U+116E U+11AB)
    const composed = '문'
    const decomposed = '문'
    expect(composed).not.toBe(decomposed)
    expect(normalizeForHash(composed)).toBe(normalizeForHash(decomposed))
    expect(hashNormalized(composed)).toBe(hashNormalized(decomposed))
  })

  it('trims surrounding whitespace before hashing', () => {
    expect(hashNormalized('  문식환  ')).toBe(hashNormalized('문식환'))
  })

  it('is deterministic and one-way (output is a 64-char hex, not the input)', () => {
    const h = hashNormalized('문식환')
    expect(h).toBe(hashNormalized('문식환'))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain('문')
  })

  it('returns null for empty/whitespace-only/nullish input', () => {
    expect(hashNormalized(null)).toBeNull()
    expect(hashNormalized('')).toBeNull()
    expect(hashNormalized('   ')).toBeNull()
  })
})

describe('buildManualAnnotationInsert', () => {
  const reviewedAt = '2026-05-24T00:00:00.000Z'
  const row = buildManualAnnotationInsert(
    {
      utteranceId: 'utt-1',
      sessionId: 'sess-1',
      piiType: 'name',
      charStart: 6,
      charEnd: 9,
      normalizedTextHash: 'abc123',
      reviewedBy: 'admin-1',
      note: null,
    },
    reviewedAt,
  )

  it('always builds an admin_manual row with null candidate_id and pending_mask status', () => {
    expect(row.source).toBe('admin_manual')
    expect(row.candidate_id).toBeNull()
    expect(row.action_status).toBe('pending_mask')
  })

  it('derives session/reviewer/offsets/hash from params', () => {
    expect(row.utterance_id).toBe('utt-1')
    expect(row.session_id).toBe('sess-1')
    expect(row.pii_type).toBe('name')
    expect(row.char_start).toBe(6)
    expect(row.char_end).toBe(9)
    expect(row.normalized_text_hash).toBe('abc123')
    expect(row.reviewed_by).toBe('admin-1')
    expect(row.reviewed_at).toBe(reviewedAt)
  })

  it('never includes a raw-text field (only hash is persisted)', () => {
    const keys = Object.keys(row)
    expect(keys).not.toContain('text')
    expect(keys).not.toContain('candidate_text')
    expect(keys).not.toContain('snippet')
    expect(keys).not.toContain('matched_text')
  })
})

describe('mapPredictedToAnnotationType (PR-P2A-2)', () => {
  it('maps every Korean candidate label to a valid enum pii_type', () => {
    for (const [korean, expected] of Object.entries(KOREAN_PII_TYPE_MAP)) {
      const mapped = mapPredictedToAnnotationType(korean)
      expect(mapped).toBe(expected)
      expect((VALID_PII_TYPES as readonly string[]).includes(mapped as string)).toBe(true)
    }
  })

  it('maps the live dev predicted_type values seen in pii_candidates', () => {
    // 이름(306), IP주소(5), 전화번호(1), 계좌번호(1)
    expect(mapPredictedToAnnotationType('이름')).toBe('name')
    expect(mapPredictedToAnnotationType('IP주소')).toBe('ip')
    expect(mapPredictedToAnnotationType('전화번호')).toBe('phone')
    expect(mapPredictedToAnnotationType('계좌번호')).toBe('account')
  })

  it('promotes 주민등록번호 to first-class resident_id (not other)', () => {
    expect(mapPredictedToAnnotationType('주민등록번호')).toBe('resident_id')
    expect(mapPredictedToAnnotationType('주민번호')).toBe('resident_id')
  })

  it('maps organization aliases', () => {
    expect(mapPredictedToAnnotationType('기관명')).toBe('organization')
    expect(mapPredictedToAnnotationType('회사명')).toBe('organization')
    expect(mapPredictedToAnnotationType('기관/회사명')).toBe('organization')
  })

  it('passes through values that are already valid enums', () => {
    expect(mapPredictedToAnnotationType('name')).toBe('name')
    expect(mapPredictedToAnnotationType('resident_id')).toBe('resident_id')
    expect(mapPredictedToAnnotationType('organization')).toBe('organization')
  })

  it('trims surrounding whitespace before mapping', () => {
    expect(mapPredictedToAnnotationType('  이름  ')).toBe('name')
    expect(mapPredictedToAnnotationType(' name ')).toBe('name')
  })

  it('returns null for unknown, empty, or non-string input', () => {
    expect(mapPredictedToAnnotationType('성씨')).toBeNull()
    expect(mapPredictedToAnnotationType('unknown')).toBeNull()
    expect(mapPredictedToAnnotationType('')).toBeNull()
    expect(mapPredictedToAnnotationType('   ')).toBeNull()
    expect(mapPredictedToAnnotationType(null)).toBeNull()
    expect(mapPredictedToAnnotationType(undefined)).toBeNull()
    expect(mapPredictedToAnnotationType(123 as unknown as string)).toBeNull()
  })
})
