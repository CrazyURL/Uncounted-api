import { describe, it, expect } from 'vitest'
import {
  checkUtteranceSyncIntegrity,
  applySyncIntegrityGate,
  DEFAULT_DURATION_TOLERANCE_SEC,
  type UtteranceSyncInput,
  type SyncIntegrityContext,
} from './syncIntegrityGate.js'

const REF: SyncIntegrityContext = { audioExportMode: 'reference_only' }
const EMB: SyncIntegrityContext = { audioExportMode: 'embedded' }

function clean(overrides: Partial<UtteranceSyncInput> = {}): UtteranceSyncInput {
  return {
    utterance_id: 'u1',
    start_sec: 1.0,
    end_sec: 2.5,
    duration_sec: 1.5,
    has_transcript: true,
    has_audio_ref: true,
    speaker_label: 'SPEAKER_00',
    pii_intervals: [],
    ...overrides,
  }
}

function detailOf(result: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) {
  return result.checks.find((c) => c.name === name)
}

describe('checkUtteranceSyncIntegrity — pass case', () => {
  it('clean utterance passes with all 8 checks present', () => {
    const r = checkUtteranceSyncIntegrity(clean(), REF)
    expect(r.ok).toBe(true)
    expect(r.checks).toHaveLength(8)
  })

  it('mask_in_bounds is not_implemented (D5) and does NOT block', () => {
    const r = checkUtteranceSyncIntegrity(clean(), REF)
    const mask = detailOf(r, 'mask_in_bounds')
    expect(mask?.detail).toMatch(/^not_implemented/)
    expect(r.ok).toBe(true)
  })

  it('does NOT mutate input timing (검증 전용, 사후 보정 금지)', () => {
    const input = clean({ start_sec: 1.0, end_sec: 2.5, duration_sec: 1.5 })
    const snapshot = { ...input }
    checkUtteranceSyncIntegrity(input, EMB)
    expect(input.start_sec).toBe(snapshot.start_sec)
    expect(input.end_sec).toBe(snapshot.end_sec)
    expect(input.duration_sec).toBe(snapshot.duration_sec)
  })
})

describe('checkUtteranceSyncIntegrity — fail cases (fail-closed)', () => {
  it('timeline inverted (end <= start) → timeline_post_clip_match fail, ok=false', () => {
    const r = checkUtteranceSyncIntegrity(clean({ start_sec: 3, end_sec: 2 }), REF)
    expect(r.ok).toBe(false)
    expect(detailOf(r, 'timeline_post_clip_match')?.ok).toBe(false)
  })

  it('negative start → fail', () => {
    expect(checkUtteranceSyncIntegrity(clean({ start_sec: -0.1, end_sec: 1 }), REF).ok).toBe(false)
  })

  it('duration drift beyond tolerance → duration_match fail', () => {
    // clip = 1.5s, duration_sec = 1.7s → drift 0.2s > 0.05s
    const r = checkUtteranceSyncIntegrity(clean({ duration_sec: 1.7 }), REF)
    expect(r.ok).toBe(false)
    expect(detailOf(r, 'duration_match')?.ok).toBe(false)
  })

  it('duration within tolerance (50ms) → pass', () => {
    // clip = 1.5s, duration_sec = 1.54s → drift 0.04s <= 0.05s
    const r = checkUtteranceSyncIntegrity(clean({ duration_sec: 1.54 }), REF)
    expect(detailOf(r, 'duration_match')?.ok).toBe(true)
    expect(r.ok).toBe(true)
  })

  it('null duration_sec → duration_match na (does not block)', () => {
    const r = checkUtteranceSyncIntegrity(clean({ duration_sec: null }), REF)
    expect(detailOf(r, 'duration_match')?.detail).toMatch(/^na/)
    expect(r.ok).toBe(true)
  })

  it('missing transcript → transcript_audio_align fail', () => {
    const r = checkUtteranceSyncIntegrity(clean({ has_transcript: false }), REF)
    expect(r.ok).toBe(false)
    expect(detailOf(r, 'transcript_audio_align')?.ok).toBe(false)
  })

  it('embedded mode without audio ref → utterance_id_file_match fail (broken pair)', () => {
    const r = checkUtteranceSyncIntegrity(clean({ has_audio_ref: false }), EMB)
    expect(r.ok).toBe(false)
    expect(detailOf(r, 'utterance_id_file_match')?.ok).toBe(false)
  })

  it('reference_only without audio ref → utterance_id_file_match na (pass)', () => {
    const r = checkUtteranceSyncIntegrity(clean({ has_audio_ref: false }), REF)
    expect(detailOf(r, 'utterance_id_file_match')?.detail).toMatch(/^na/)
    expect(r.ok).toBe(true)
  })

  it('empty speaker_label → speaker_id_in_profile fail; UNKNOWN passes', () => {
    expect(checkUtteranceSyncIntegrity(clean({ speaker_label: '' }), REF).ok).toBe(false)
    expect(checkUtteranceSyncIntegrity(clean({ speaker_label: 'UNKNOWN' }), REF).ok).toBe(true)
  })

  it('pii interval longer than clip → pii_in_bounds fail', () => {
    // clip = 1.5s; pii interval 2s long
    const r = checkUtteranceSyncIntegrity(
      clean({ pii_intervals: [{ start_sec: 0, end_sec: 2.0 }] }),
      REF,
    )
    expect(r.ok).toBe(false)
    expect(detailOf(r, 'pii_in_bounds')?.ok).toBe(false)
  })

  it('valid in-bounds pii interval → pass', () => {
    const r = checkUtteranceSyncIntegrity(
      clean({ pii_intervals: [{ start_sec: 1.1, end_sec: 1.4 }] }),
      REF,
    )
    expect(detailOf(r, 'pii_in_bounds')?.ok).toBe(true)
    expect(r.ok).toBe(true)
  })

  it('malformed pii interval (inverted) → fail', () => {
    const r = checkUtteranceSyncIntegrity(
      clean({ pii_intervals: [{ start_sec: 1.4, end_sec: 1.1 }] }),
      REF,
    )
    expect(r.ok).toBe(false)
  })
})

describe('applySyncIntegrityGate — partition + report', () => {
  it('partitions kept/excluded, fail-closed on broken utterances', () => {
    const inputs = [
      clean({ utterance_id: 'ok1' }),
      clean({ utterance_id: 'bad-timeline', start_sec: 5, end_sec: 4 }),
      clean({ utterance_id: 'ok2' }),
      clean({ utterance_id: 'bad-transcript', has_transcript: false }),
    ]
    const out = applySyncIntegrityGate(inputs, REF)
    expect(out.kept.map((k) => k.utterance_id)).toEqual(['ok1', 'ok2'])
    expect(out.excluded.map((e) => e.utterance_id).sort()).toEqual(['bad-timeline', 'bad-transcript'])
    expect(out.report.kept_count).toBe(2)
    expect(out.report.excluded_count).toBe(2)
  })

  it('report records failed_checks per excluded utterance and check_distribution', () => {
    const out = applySyncIntegrityGate(
      [clean({ utterance_id: 'bad', has_transcript: false })],
      REF,
    )
    expect(out.report.excluded[0].failed_checks).toContain('transcript_audio_align')
    expect(out.report.check_distribution.mask_in_bounds.not_implemented).toBe(1)
    expect(out.report.check_distribution.transcript_audio_align.fail).toBe(1)
    expect(out.report.tolerance_sec).toBe(DEFAULT_DURATION_TOLERANCE_SEC)
  })

  it('report contains NO text/PII content — only utterance_id + check names', () => {
    const out = applySyncIntegrityGate([clean({ utterance_id: 'bad', has_transcript: false })], REF)
    const serialized = JSON.stringify(out.report)
    // 화자/텍스트/원문 노출 없음. utterance_id 와 체크명만.
    expect(serialized).not.toContain('SPEAKER_00')
    expect(serialized).toContain('bad')
    expect(serialized).toContain('transcript_audio_align')
  })

  it('report surface is locked to expected keys (no field widening)', () => {
    const out = applySyncIntegrityGate([clean()], REF)
    expect(Object.keys(out.report).sort()).toEqual(
      [
        'audio_export_mode',
        'check_distribution',
        'excluded',
        'excluded_count',
        'gate',
        'kept_count',
        'notes',
        'tolerance_sec',
      ].sort(),
    )
  })

  it('all-excluded edge → empty kept set, no throw', () => {
    const out = applySyncIntegrityGate([clean({ start_sec: 2, end_sec: 1 })], EMB)
    expect(out.kept).toHaveLength(0)
    expect(out.report.excluded_count).toBe(1)
  })

  it('empty input → empty report', () => {
    const out = applySyncIntegrityGate([], REF)
    expect(out.kept).toHaveLength(0)
    expect(out.report.kept_count).toBe(0)
    expect(out.report.excluded_count).toBe(0)
  })
})
