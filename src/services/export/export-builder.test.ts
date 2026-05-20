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
