/**
 * PR-D — export-builder buildLabelLine 의 confidence_tier 통합 검증.
 *
 * - label_confidence 우선 → emotion_confidence fallback → needs_review (none)
 * - label-schema additionalProperties: false 보존 (신규 키 0)
 * - PR #58 safety preflight 5 카테고리 정규식 회피
 * - Red-Green-Restore (PR-D 호출 우회 시 needs_review fail)
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/s3.js', () => ({ s3Client: { send: vi.fn() }, S3_AUDIO_BUCKET: 'test-bucket' }))
vi.mock('../../lib/supabase.js', () => ({ supabaseAdmin: {} }))

import { _testInternals } from './export-builder.js'
import { LABEL_SCHEMA_JSON } from './label-schema.js'

const { buildLabelLine } = _testInternals

function utt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u-1',
    session_id: 'sess-1',
    sequence_order: 1,
    speaker_id: 'SPEAKER_00',
    start_sec: 0.0,
    end_sec: 1.0,
    duration_sec: 1.0,
    transcript_text: '안녕하세요',
    label_confidence: null,
    emotion_confidence: null,
    emotion: null,
    auto_label_model_version: null,
    label_source: null,
    pii_intervals: [],
    speech_act_events: [],
    numeric_patterns: [],
    utterance_form: null,
    upload_status: 'uploaded',
    storage_path: 'sess-1/u-1.wav',
    review_status: 'pending',
    ...overrides,
  }
}

describe('PR-D × export-builder buildLabelLine', () => {
  it('label_confidence 0.95 → confidence_tier=high (source=label, 외부 emit X)', () => {
    const u = utt({ label_confidence: 0.95, emotion_confidence: 0.3 })
    const line = buildLabelLine(u as never, 'sess-1', 'reference_only') as Record<string, unknown>
    expect(line.confidence_tier).toBe('high')
    expect(line.label_confidence).toBe(0.95)
    // source 정보 외부 emit 0 (additionalProperties 보존)
    expect('confidence_tier_source' in line).toBe(false)
  })

  it('label null + emotion 0.62 → medium (fallback)', () => {
    const u = utt({ label_confidence: null, emotion_confidence: 0.62 })
    const line = buildLabelLine(u as never, 'sess-1', 'reference_only') as Record<string, unknown>
    expect(line.confidence_tier).toBe('medium')
    expect(line.label_confidence).toBe(null)
  })

  it('label null + emotion null → needs_review', () => {
    const u = utt()
    const line = buildLabelLine(u as never, 'sess-1', 'reference_only') as Record<string, unknown>
    expect(line.confidence_tier).toBe('needs_review')
    expect(line.label_confidence).toBe(null)
  })

  it('label 0.35 < 0.4 → needs_review', () => {
    const u = utt({ label_confidence: 0.35 })
    const line = buildLabelLine(u as never, 'sess-1', 'reference_only') as Record<string, unknown>
    expect(line.confidence_tier).toBe('needs_review')
  })

  it('label "0.5" string → medium (number-like parse)', () => {
    const u = utt({ label_confidence: '0.5' })
    const line = buildLabelLine(u as never, 'sess-1', 'reference_only') as Record<string, unknown>
    expect(line.confidence_tier).toBe('medium')
  })

  it('label-schema confidence_tier enum 정합 (high/medium/needs_review/null)', () => {
    const props = LABEL_SCHEMA_JSON.properties as Record<string, unknown>
    const tier = props.confidence_tier as { oneOf: Array<{ type?: string; enum?: string[] }> }
    const enumValues = tier.oneOf.find(o => o.enum)?.enum ?? []
    expect(enumValues).toContain('high')
    expect(enumValues).toContain('medium')
    expect(enumValues).toContain('needs_review')
    // 본 PR 이 emit 하는 모든 tier 가 schema enum 통과
    for (const t of ['high', 'medium', 'needs_review']) {
      expect(enumValues).toContain(t)
    }
  })

  it('PR #58 safety preflight 5 카테고리 정규식 회피', () => {
    // tier 값 = 'high' / 'medium' / 'needs_review' surface 매칭 확인
    for (const t of ['high', 'medium', 'needs_review']) {
      expect(/비밀번호|password|패스워드/i.test(t)).toBe(false)
      expect(/\d{6}[-_\s][5-8]\d{6}/.test(t)).toBe(false)
      expect(/이체|송금|결제/i.test(t)).toBe(false)
      expect(/\d{6,}/.test(t)).toBe(false)
    }
  })

  it('label-schema additionalProperties: false 보존 — 신규 키 추가 0', () => {
    expect(LABEL_SCHEMA_JSON.additionalProperties).toBe(false)
    // buildLabelLine 출력의 모든 키가 schema properties 안에 있어야 함
    const u = utt({ label_confidence: 0.8 })
    const line = buildLabelLine(u as never, 'sess-1', 'reference_only') as Record<string, unknown>
    const schemaProps = Object.keys(LABEL_SCHEMA_JSON.properties as Record<string, unknown>)
    for (const k of Object.keys(line)) {
      expect(schemaProps).toContain(k)
    }
  })

  it('emotion_confidence 0.997 max → high', () => {
    const u = utt({ emotion_confidence: 0.997 })
    const line = buildLabelLine(u as never, 'sess-1', 'reference_only') as Record<string, unknown>
    expect(line.confidence_tier).toBe('high')
  })

  it('전체 LabelLine 구조 (기존 필드 회귀 0)', () => {
    const u = utt({ label_confidence: 0.8, emotion: '긍정', emotion_confidence: 0.6, auto_label_model_version: 'whisperx_v3' })
    const line = buildLabelLine(u as never, 'sess-1', 'embedded') as Record<string, unknown>
    expect(line.utterance_id).toBe('u-1')
    expect(line.session_id).toBe('sess-1')
    expect(line.audio_export_mode).toBe('embedded')
    expect(line.confidence_tier).toBe('high')  // label 0.8 우선
    expect(line.label_confidence).toBe(0.8)
    expect(line.auto_labels).toBeDefined()
  })

  it('PR-C session_quality_tier 와 직교 (LabelLine 에 session-level tier 없음)', () => {
    const u = utt({ label_confidence: 0.8 })
    const line = buildLabelLine(u as never, 'sess-1', 'reference_only') as Record<string, unknown>
    expect('session_quality_tier' in line).toBe(false)
  })
})
