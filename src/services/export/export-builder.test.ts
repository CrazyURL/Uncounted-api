/**
 * export-builder integration smoke test.
 *
 * DB 없이 sanitize 헬퍼와 안전선 강제 로직만 검증.
 * 실제 buildSessionExportZip() 통합 호출은 dev DB + 적격 세션 필요 (다음 단계).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import {
  sanitizeExternalLabelOrigin,
  sanitizeExternalMethod,
  sanitizeExternalSpeakerRole,
} from '../../lib/export/transforms.js'
import { LABEL_SCHEMA_JSON, ALLOWED_METHODS, ALLOWED_SPEAKER_ROLE_CANDIDATES } from './label-schema.js'

// s3Client mock — downloadAudioFilesToStaging 가 S3 대신 가짜 WAV 바이트를 받도록.
const s3SendMock = vi.fn()
vi.mock('../../lib/s3.js', () => ({
  s3Client: { send: (...args: unknown[]) => s3SendMock(...args) },
  S3_AUDIO_BUCKET: 'test-bucket',
}))
// supabase mock — _testInternals 만 쓰므로 실제 호출 없음. import 안전망.
vi.mock('../../lib/supabase.js', () => ({ supabaseAdmin: {} }))

describe('export-builder — transforms 안전선 강제', () => {
  it('#1: speaker role allowlist (owner_candidate / counterparty_candidate / unknown)', () => {
    expect(sanitizeExternalSpeakerRole('owner')).toBe('owner_candidate')
    expect(sanitizeExternalSpeakerRole('counterparty')).toBe('counterparty_candidate')
    expect(sanitizeExternalSpeakerRole('self')).toBe('unknown')
    expect(sanitizeExternalSpeakerRole('other')).toBe('unknown')
    expect(sanitizeExternalSpeakerRole('SPEAKER_00')).toBe('unknown')
    expect(sanitizeExternalSpeakerRole(null)).toBe('unknown')
  })

  it('#6: label_origin / label_version 외부 5종 allowlist', () => {
    expect(sanitizeExternalLabelOrigin('aihub_v1')).toBe('supervised_model')
    expect(sanitizeExternalMethod('kcelectra_v3')).toBe('supervised_model')
    expect(sanitizeExternalMethod('whisperx_v3')).toBe('automatic')
    expect(sanitizeExternalMethod(null)).toBe('not_available')
    expect(sanitizeExternalLabelOrigin('automatic')).toBe('automatic')
  })

  it('label_schema.json: speaker_label 은 자유 문자열 (익명 diarization)', () => {
    const speakerLabel = LABEL_SCHEMA_JSON.properties.speaker_label
    expect(speakerLabel.type).toBe('string')
    expect('enum' in speakerLabel).toBe(false)
  })

  it('label_schema.json: speaker_role_candidate enum 은 후보값만 (#1)', () => {
    const roleEnum = LABEL_SCHEMA_JSON.properties.speaker_role_candidate.enum
    expect(roleEnum).toContain('owner_candidate')
    expect(roleEnum).toContain('counterparty_candidate')
    expect(roleEnum).toContain('unknown')
    expect(roleEnum).not.toContain('self')
    expect(roleEnum).not.toContain('other')
    expect(roleEnum).not.toContain('owner')
    expect(roleEnum).not.toContain('counterparty')
  })

  it('label_schema.json: confidence_tier 는 required 아님 (#컬럼 미존재 허용)', () => {
    expect(LABEL_SCHEMA_JSON.required).not.toContain('confidence_tier')
  })

  it('label_schema.json: method/label_version enum 은 5종 allowlist', () => {
    expect(ALLOWED_METHODS).toEqual([
      'automatic',
      'supervised_model',
      'rule_based_mvp',
      'heuristic_mvp',
      'not_available',
    ])
    expect(ALLOWED_SPEAKER_ROLE_CANDIDATES).toEqual([
      'owner_candidate',
      'counterparty_candidate',
      'unknown',
    ])
  })

  it('label_schema.json: pii_labels additionalProperties=false (#3)', () => {
    const piiSchema = LABEL_SCHEMA_JSON.properties.pii_labels.items
    expect(piiSchema.additionalProperties).toBe(false)
    expect(Object.keys(piiSchema.properties)).not.toContain('original')
  })

  it('label_schema.json: numeric_patterns 는 masked 필드만 (#4)', () => {
    const npSchema = LABEL_SCHEMA_JSON.properties.numeric_patterns.items
    expect(npSchema.additionalProperties).toBe(false)
    const propKeys = Object.keys(npSchema.properties)
    expect(propKeys).toContain('surface_masked')
    expect(propKeys).toContain('normalized_masked')
    expect(propKeys).not.toContain('surface_text')
    expect(propKeys).not.toContain('normalized')
  })
})

// ── Phase 1: audio_manifest 내부/외부 필드 분리 ─────────────────────────────
describe('export-builder — buildAudioManifest 하드닝', () => {
  // import 는 mock 적용 이후 동적으로 가져온다.
  async function getInternals() {
    const mod = await import('./export-builder.js')
    return mod._testInternals
  }

  const utts = [
    { id: 'u1', storage_path: 'audio/sess1/u1.wav', start_sec: 0, end_sec: 1.5, duration_sec: 1.5 },
    { id: 'u2', storage_path: 'audio/sess1/u2.wav', start_sec: 1.5, end_sec: 3, duration_sec: 1.5 },
  ] as never[]

  it('reference_only: audio_reference_id 만, s3_key/storage_path 미노출, zip_path=null', async () => {
    const { buildAudioManifest } = await getInternals()
    const manifest = buildAudioManifest(utts, 'sess1', 'reference_only') as {
      items: Record<string, unknown>[]
    }
    const json = JSON.stringify(manifest)
    expect(json).not.toContain('s3_key')
    expect(json).not.toContain('storage_path')
    expect(manifest.items[0].audio_reference_id).toBe('utt_u1')
    expect(manifest.items[0].zip_path).toBeNull()
    expect(manifest.items[0].segment_audio_included).toBe(false)
  })

  it('embedded: zip_path=audio/{sid}/utt_{id}.wav, segment_audio_included=true', async () => {
    const { buildAudioManifest } = await getInternals()
    const manifest = buildAudioManifest(utts, 'sess1', 'embedded') as {
      items: Record<string, unknown>[]
    }
    expect(manifest.items[0].zip_path).toBe('audio/sess1/utt_u1.wav')
    expect(manifest.items[0].segment_audio_included).toBe(true)
    expect(JSON.stringify(manifest)).not.toContain('storage_path')
  })
})

// ── Phase 2A: embedded WAV S3 다운로드 → staging 파일 기록 ──────────────────
describe('export-builder — downloadAudioFilesToStaging (embedded)', () => {
  let stagingDir: string

  beforeEach(async () => {
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'export-audio-test-'))
    s3SendMock.mockReset()
    // 매 호출마다 가짜 WAV 바이트를 담은 Readable 반환.
    s3SendMock.mockImplementation(async () => ({
      Body: Readable.from([Buffer.from('FAKE_WAV_BYTES')]),
    }))
  })

  afterEach(async () => {
    await fs.rm(stagingDir, { recursive: true, force: true })
  })

  it('storage_path 보유 발화마다 audio/{sid}/utt_{id}.wav 를 기록한다', async () => {
    const { downloadAudioFilesToStaging } = await import('./export-builder.js').then((m) => m._testInternals)
    const utterances = [
      { id: 'u1', storage_path: 'audio/sess1/u1.wav' },
      { id: 'u2', storage_path: 'audio/sess1/u2.wav' },
    ] as never[]

    await downloadAudioFilesToStaging(stagingDir, 'sess1', utterances)

    const w1 = await fs.readFile(path.join(stagingDir, 'audio', 'sess1', 'utt_u1.wav'), 'utf-8')
    const w2 = await fs.readFile(path.join(stagingDir, 'audio', 'sess1', 'utt_u2.wav'), 'utf-8')
    expect(w1).toBe('FAKE_WAV_BYTES')
    expect(w2).toBe('FAKE_WAV_BYTES')
    expect(s3SendMock).toHaveBeenCalledTimes(2)
  })

  it('storage_path 없는 발화는 건너뛴다', async () => {
    const { downloadAudioFilesToStaging } = await import('./export-builder.js').then((m) => m._testInternals)
    const utterances = [
      { id: 'u1', storage_path: null },
      { id: 'u2', storage_path: 'audio/sess1/u2.wav' },
    ] as never[]

    await downloadAudioFilesToStaging(stagingDir, 'sess1', utterances)

    await expect(
      fs.readFile(path.join(stagingDir, 'audio', 'sess1', 'utt_u1.wav'), 'utf-8'),
    ).rejects.toThrow()
    const w2 = await fs.readFile(path.join(stagingDir, 'audio', 'sess1', 'utt_u2.wav'), 'utf-8')
    expect(w2).toBe('FAKE_WAV_BYTES')
    expect(s3SendMock).toHaveBeenCalledTimes(1)
  })
})

// ── auto_labels.emotion: flat 컬럼 매핑 (labels JSONB 버그 수정) ────────────
describe('export-builder — buildLabelLine auto_labels.emotion (flat 매핑)', () => {
  async function getBuildLabelLine() {
    const { buildLabelLine } = await import('./export-builder.js').then((m) => m._testInternals)
    return buildLabelLine as (
      u: Record<string, unknown>,
      sessionId: string,
      audioExportMode: 'reference_only' | 'embedded',
    ) => Record<string, unknown>
  }

  const baseUtt = {
    id: 'u1',
    session_id: 'sess1',
    sequence_order: 0,
    speaker_id: 'SPEAKER_00',
    start_sec: 0,
    end_sec: 1.5,
    transcript_text: '안녕하세요',
  }

  it('flat 컬럼에서 emotion 을 자동 추정 object 로 매핑한다', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const line = buildLabelLine(
      {
        ...baseUtt,
        emotion: '긍정',
        emotion_confidence: '0.870', // supabase NUMERIC 은 string 으로 옴
        auto_label_model_version: 'kcelectra_emotion_v1',
        labels: null,
      },
      'sess1',
      'reference_only',
    )
    const autoLabels = line.auto_labels as Record<string, unknown>
    expect(autoLabels.emotion).toEqual({
      value: '긍정',
      confidence: 0.87,
      source: 'automatic',
      model_version: 'supervised_model', // sanitizeExternalMethod(kcelectra_*) (안전선 #6)
    })
  })

  it('안전선 #6: raw 내부 모델명(kcelectra)이 직렬화 결과에 노출되지 않는다', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const line = buildLabelLine(
      {
        ...baseUtt,
        emotion: '부정',
        emotion_confidence: 0.42,
        auto_label_model_version: 'kcelectra_emotion_v1',
        labels: null,
      },
      'sess1',
      'reference_only',
    )
    expect(JSON.stringify(line)).not.toContain('kcelectra')
  })

  it('emotion 미산출(null/empty) 이면 auto_labels.emotion=null', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const nullLine = buildLabelLine({ ...baseUtt, emotion: null }, 'sess1', 'reference_only')
    const emptyLine = buildLabelLine({ ...baseUtt, emotion: '' }, 'sess1', 'reference_only')
    expect((nullLine.auto_labels as Record<string, unknown>).emotion).toBeNull()
    expect((emptyLine.auto_labels as Record<string, unknown>).emotion).toBeNull()
  })

  it('labels JSONB(사람 검수) 의 stale emotion 은 무시하고 flat 컬럼을 사용한다', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const line = buildLabelLine(
      {
        ...baseUtt,
        emotion: '부정',
        emotion_confidence: 0.61,
        labels: { emotion: { value: 'STALE_HUMAN_LABEL' } },
      },
      'sess1',
      'reference_only',
    )
    const emotion = (line.auto_labels as Record<string, unknown>).emotion as Record<string, unknown>
    expect(emotion.value).toBe('부정')
    expect(JSON.stringify(line)).not.toContain('STALE_HUMAN_LABEL')
  })

  it('speech_act 라인은 이번 수정의 영향을 받지 않는다(기존 동작 유지)', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const line = buildLabelLine(
      {
        ...baseUtt,
        emotion: '중립',
        speech_act_events: [{ value: '질문', confidence: 0.9, method: 'rule_v1' }],
      },
      'sess1',
      'reference_only',
    )
    const autoLabels = line.auto_labels as Record<string, unknown>
    expect(autoLabels.speech_act).toEqual({
      value: '질문',
      confidence: 0.9,
      method: 'rule_based_mvp',
    })
  })
})
