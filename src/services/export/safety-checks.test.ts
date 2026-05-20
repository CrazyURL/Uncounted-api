import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

import {
  validateExportSafety,
  sanitizeMethodValue,
  FORBIDDEN_SPEAKER_ROLES,
  ALLOWED_SPEAKER_ROLES,
} from './safety-checks.js'

async function makeStaging(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeFile(dir: string, rel: string, body: string): Promise<void> {
  const full = path.join(dir, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, body, 'utf-8')
}

describe('safety-checks — sanitizeMethodValue', () => {
  it('maps internal model names to external allowlist (#6)', () => {
    expect(sanitizeMethodValue('kcelectra_v3')).toBe('supervised_model')
    expect(sanitizeMethodValue('whisperx_v3_large')).toBe('automatic')
    expect(sanitizeMethodValue('aihub_v1')).toBe('supervised_model')
    expect(sanitizeMethodValue('pyannote_v3')).toBe('automatic')
    expect(sanitizeMethodValue(null)).toBe('not_available')
    expect(sanitizeMethodValue('rule_v2')).toBe('rule_based_mvp')
  })
})

describe('safety-checks — allowlist exports', () => {
  it('exports FORBIDDEN_SPEAKER_ROLES and ALLOWED_SPEAKER_ROLES', () => {
    expect(FORBIDDEN_SPEAKER_ROLES).toContain('self')
    expect(FORBIDDEN_SPEAKER_ROLES).toContain('owner')
    expect(ALLOWED_SPEAKER_ROLES).toContain('owner_candidate')
    expect(ALLOWED_SPEAKER_ROLES).toContain('unknown')
  })
})

describe('safety-checks — validateExportSafety', () => {
  let stagingDir: string

  beforeEach(async () => {
    stagingDir = await makeStaging('safety-test-')
  })

  afterEach(async () => {
    await fs.rm(stagingDir, { recursive: true, force: true })
  })

  it('passes empty staging dir', async () => {
    const result = await validateExportSafety(stagingDir)
    expect(result.violations).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('passes clean v2 ZIP content', async () => {
    await writeFile(
      stagingDir,
      'manifest.json',
      JSON.stringify({
        manifest_version: 'v2',
        session_id: 'sess_001',
        audio_export_mode: 'reference_only',
      }),
    )
    await writeFile(
      stagingDir,
      'labels/labels_sess_001.jsonl',
      JSON.stringify({
        utterance_id: 'utt_001',
        speaker_label: 'SPEAKER_00',
        speaker_role_candidate: 'owner_candidate',
        label_origin: 'supervised_model',
        label_version: 'automatic',
        audio_export_mode: 'reference_only',
        numeric_patterns: [
          { type: 'phone_number', surface_masked: '[PHONE]', normalized_masked: '[PHONE]', pii_related: true },
        ],
        pii_labels: [{ startSec: 0.5, endSec: 1.2, maskType: 'beep', piiType: 'name' }],
      }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations).toEqual([])
  })

  it('flags Hard Block keyword (#6)', async () => {
    await writeFile(
      stagingDir,
      'metadata/processing_summary.json',
      JSON.stringify({ pipeline: 'whisperx_v3_large' }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations.some((v) => v.toLowerCase().includes('whisperx'))).toBe(true)
  })

  it('flags forbidden JSON key "original" in pii_labels (#3)', async () => {
    await writeFile(
      stagingDir,
      'labels/labels_x.jsonl',
      JSON.stringify({
        pii_labels: [{ startSec: 0, endSec: 1, original: 'John', maskType: 'beep', piiType: 'name' }],
      }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations.some((v) => v.includes('"original"'))).toBe(true)
  })

  it('flags forbidden JSON key "surface_text" in numeric_patterns (#4)', async () => {
    await writeFile(
      stagingDir,
      'labels/labels_x.jsonl',
      JSON.stringify({
        numeric_patterns: [{ type: 'phone_number', surface_text: '010-1234-5678', surface_masked: '[PHONE]' }],
      }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations.some((v) => v.includes('"surface_text"'))).toBe(true)
  })

  it('flags forbidden speaker role value "self" by exact match (#1)', async () => {
    await writeFile(
      stagingDir,
      'labels/labels_x.jsonl',
      JSON.stringify({ utterance_id: 'utt1', speaker_role_candidate: 'self' }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations.some((v) => v.includes('speaker role'))).toBe(true)
  })

  it('does NOT flag "owner_candidate" (substring match avoided)', async () => {
    await writeFile(
      stagingDir,
      'labels/labels_x.jsonl',
      JSON.stringify({ speaker_role_candidate: 'owner_candidate' }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations).toEqual([])
  })

  it('does NOT flag anonymous diarization label in speaker_label (#1 not applied)', async () => {
    // speaker_label 은 SPEAKER_00 같은 익명 라벨 필드 — 안전선 #1 검사 대상 아님.
    await writeFile(
      stagingDir,
      'labels/labels_x.jsonl',
      JSON.stringify({ speaker_label: 'SPEAKER_00' }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations).toEqual([])
  })

  it('flags invalid JSONL line as violation', async () => {
    await writeFile(stagingDir, 'labels/labels_x.jsonl', 'this is not json\n{"ok":true}\n')
    const result = await validateExportSafety(stagingDir)
    expect(result.violations.some((v) => v.includes('invalid JSON'))).toBe(true)
  })

  it('does not scan WAV files', async () => {
    // WAV is binary — should be excluded from text scan entirely.
    // Even if its bytes happen to contain "whisperx" substring, it should not trigger.
    await writeFile(
      stagingDir,
      'audio/sess/utt_x.wav',
      'this fake wav contains whisperx and aihub keywords',
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations).toEqual([])
  })

  // ── audio_manifest 하드닝 (내부 S3 키/URL 외부 노출 차단) ─────────────
  it('flags forbidden key "s3_key" in audio_manifest', async () => {
    await writeFile(
      stagingDir,
      'metadata/audio_manifest.json',
      JSON.stringify({ items: [{ utterance_id: 'u1', s3_key: 'audio/sess/u1.wav' }] }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations.some((v) => v.includes('"s3_key"'))).toBe(true)
  })

  it('flags forbidden key "storage_path"', async () => {
    await writeFile(
      stagingDir,
      'metadata/audio_manifest.json',
      JSON.stringify({ items: [{ utterance_id: 'u1', storage_path: 'audio/sess/u1.wav' }] }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations.some((v) => v.includes('"storage_path"'))).toBe(true)
  })

  it('flags s3:// URI in content', async () => {
    await writeFile(
      stagingDir,
      'metadata/audio_manifest.json',
      JSON.stringify({ ref: 's3://my-bucket/audio/u1.wav' }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations.some((v) => v.includes('s3:// URI'))).toBe(true)
  })

  it('flags AWS signed URL params in content', async () => {
    await writeFile(
      stagingDir,
      'metadata/audio_manifest.json',
      JSON.stringify({ url: 'https://b.s3.amazonaws.com/u1.wav?X-Amz-Signature=abc123&X-Amz-Credential=xyz' }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations.some((v) => v.includes('signed URL'))).toBe(true)
  })

  it('passes hardened audio_manifest (audio_reference_id + zip_path only)', async () => {
    await writeFile(
      stagingDir,
      'metadata/audio_manifest.json',
      JSON.stringify({
        session_id: 'sess_001',
        audio_export_mode: 'embedded',
        items: [
          { utterance_id: 'u1', audio_reference_id: 'utt_u1', zip_path: 'audio/sess_001/utt_u1.wav', segment_audio_included: true },
        ],
      }),
    )
    const result = await validateExportSafety(stagingDir)
    expect(result.violations).toEqual([])
  })
})
