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
      sub: null, // 세부감정 미산출(emotion_category 없음) → null-safe
    })
  })

  it('세부감정(sub): emotion_category 있으면 auto_labels.emotion.sub 로 노출', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const line = buildLabelLine(
      {
        ...baseUtt,
        emotion: '부정',
        emotion_confidence: 0.8,
        emotion_category: '슬픔',
        emotion_category_confidence: '0.730', // supabase NUMERIC → string
      },
      'sess1',
      'reference_only',
    )
    const emotion = (line.auto_labels as Record<string, unknown>).emotion as Record<string, unknown>
    expect(emotion.sub).toEqual({ value: '슬픔', confidence: 0.73 })
  })

  it('세부감정(sub) null-safe: emotion_category 미산출(현재 0%)이면 sub=null', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const nullCat = buildLabelLine(
      { ...baseUtt, emotion: '긍정', emotion_confidence: 0.9, emotion_category: null },
      'sess1',
      'reference_only',
    )
    const emptyCat = buildLabelLine(
      { ...baseUtt, emotion: '긍정', emotion_confidence: 0.9, emotion_category: '' },
      'sess1',
      'reference_only',
    )
    const absent = buildLabelLine(
      { ...baseUtt, emotion: '긍정', emotion_confidence: 0.9 },
      'sess1',
      'reference_only',
    )
    expect((nullCat.auto_labels as Record<string, unknown>).emotion).toMatchObject({ sub: null })
    expect((emptyCat.auto_labels as Record<string, unknown>).emotion).toMatchObject({ sub: null })
    expect((absent.auto_labels as Record<string, unknown>).emotion).toMatchObject({ sub: null })
  })

  it('세부감정(sub) confidence 미산출 → sub.value 유지, confidence=null', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const line = buildLabelLine(
      { ...baseUtt, emotion: '부정', emotion_category: '분노' },
      'sess1',
      'reference_only',
    )
    const emotion = (line.auto_labels as Record<string, unknown>).emotion as Record<string, unknown>
    expect(emotion.sub).toEqual({ value: '분노', confidence: null })
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

  it('speech_act(대화목적)을 dialog_act 백필 컬럼에서 생성한다', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const line = buildLabelLine(
      {
        ...baseUtt,
        emotion: '중립',
        // 실제 백필: speech_act_events 는 비어 있고 dialog_act flat 컬럼에 라벨이 들어옴.
        speech_act_events: [],
        dialog_act: '제안',
        dialog_act_confidence: '0.9', // supabase NUMERIC → string
        label_source: 'heuristic_mvp',
      },
      'sess1',
      'reference_only',
    )
    const autoLabels = line.auto_labels as Record<string, unknown>
    expect(autoLabels.speech_act).toEqual({
      value: '제안',
      confidence: 0.9,
      // 안전선 #12: heuristic_mvp 임시 라벨을 supervised 로 위장하지 않고 정직 노출.
      method: 'heuristic_mvp',
    })
  })

  it('dialog_act 미산출이면 speech_act=null (정직 노출, fallback)', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const nullLine = buildLabelLine(
      { ...baseUtt, dialog_act: null, label_source: 'heuristic_mvp' },
      'sess1',
      'reference_only',
    )
    const emptyLine = buildLabelLine(
      { ...baseUtt, dialog_act: '', label_source: 'heuristic_mvp' },
      'sess1',
      'reference_only',
    )
    expect((nullLine.auto_labels as Record<string, unknown>).speech_act).toBeNull()
    expect((emptyLine.auto_labels as Record<string, unknown>).speech_act).toBeNull()
  })

  it('conversation_context 는 DB JSONB 그대로 passthrough (하드코딩 null 아님)', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const cc = {
      turn_index: 1,
      topic_thread: '건강/의료',
      discourse_role: 'opening',
      prev_turn_gist: 'default_context',
    }
    const line = buildLabelLine(
      { ...baseUtt, conversation_context: cc },
      'sess1',
      'reference_only',
    )
    expect(line.conversation_context).toEqual(cc)
  })

  it('conversation_context 미백필이면 null', async () => {
    const buildLabelLine = await getBuildLabelLine()
    const line = buildLabelLine({ ...baseUtt }, 'sess1', 'reference_only')
    expect(line.conversation_context).toBeNull()
  })
})

describe('export-builder — buildEmotionDetail (V-A 차원감정)', () => {
  async function internals() {
    return await import('./export-builder.js').then((m) => m._testInternals)
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

  it('세 V-A 값이 모두 있으면 {valence,arousal,dominance,method} 실값 반환', async () => {
    const { buildEmotionDetail } = await internals()
    const detail = buildEmotionDetail({
      ...baseUtt,
      emotion_valence: 0.299,
      emotion_arousal: 0.723,
      emotion_dominance: 0.716,
    } as never)
    expect(detail).toEqual({
      valence: 0.299,
      arousal: 0.723,
      dominance: 0.716,
      method: 'automatic',
    })
  })

  it('supabase NUMERIC(string) 입력도 number 로 변환한다', async () => {
    const { buildEmotionDetail } = await internals()
    const detail = buildEmotionDetail({
      ...baseUtt,
      emotion_valence: '0.437',
      emotion_arousal: '0.718',
      emotion_dominance: '0.719',
    } as never) as Record<string, unknown>
    expect(detail.valence).toBe(0.437)
    expect(detail.arousal).toBe(0.718)
    expect(detail.dominance).toBe(0.719)
    expect(typeof detail.valence).toBe('number')
  })

  it('세 축 중 하나라도 결측이면 null (부분 노출 금지)', async () => {
    const { buildEmotionDetail } = await internals()
    expect(
      buildEmotionDetail({ ...baseUtt, emotion_valence: 0.5, emotion_arousal: 0.5, emotion_dominance: null } as never),
    ).toBeNull()
    expect(
      buildEmotionDetail({ ...baseUtt, emotion_valence: 0.5, emotion_arousal: null, emotion_dominance: 0.5 } as never),
    ).toBeNull()
    expect(
      buildEmotionDetail({ ...baseUtt, emotion_valence: undefined, emotion_arousal: 0.5, emotion_dominance: 0.5 } as never),
    ).toBeNull()
  })

  it('buildLabelLine.emotion_detail 가 V-A 실값으로 배선된다 (하드코딩 null 아님)', async () => {
    const { buildLabelLine } = await internals()
    const line = buildLabelLine(
      { ...baseUtt, emotion_valence: 0.299, emotion_arousal: 0.723, emotion_dominance: 0.716 } as never,
      'sess1',
      'reference_only',
    )
    expect(line.emotion_detail).toEqual({
      valence: 0.299,
      arousal: 0.723,
      dominance: 0.716,
      method: 'automatic',
    })
  })

  it('V-A 미산출 발화는 emotion_detail=null', async () => {
    const { buildLabelLine } = await internals()
    const line = buildLabelLine({ ...baseUtt } as never, 'sess1', 'reference_only')
    expect(line.emotion_detail).toBeNull()
  })

  it('안전선 #6: 모델명(audeering/wav2vec)이 emotion_detail 직렬화에 노출되지 않는다', async () => {
    const { buildLabelLine } = await internals()
    const line = buildLabelLine(
      { ...baseUtt, emotion_valence: 0.5, emotion_arousal: 0.5, emotion_dominance: 0.5 } as never,
      'sess1',
      'reference_only',
    )
    const s = JSON.stringify(line)
    expect(s).not.toContain('audeering')
    expect(s).not.toContain('wav2vec')
  })
})

describe('export-builder — buildProsody (침묵/비유창성/발화속도)', () => {
  async function internals() {
    return await import('./export-builder.js').then((m) => m._testInternals)
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

  it('세 값이 모두 있으면 {silence_before_sec,filler_word_count,speech_rate_wpm} 실값 반환', async () => {
    const { buildProsody } = await internals()
    const prosody = buildProsody({
      ...baseUtt,
      silence_before_sec: 2.12,
      filler_word_count: 0,
      speech_rate_wpm: 61.5,
    } as never)
    expect(prosody).toEqual({
      silence_before_sec: 2.12,
      filler_word_count: 0,
      speech_rate_wpm: 61.5,
    })
  })

  it('supabase NUMERIC(string) 입력도 number 로 변환한다', async () => {
    const { buildProsody } = await internals()
    const prosody = buildProsody({
      ...baseUtt,
      silence_before_sec: '0.71',
      filler_word_count: '1',
      speech_rate_wpm: '63.6',
    } as never) as Record<string, unknown>
    expect(prosody.silence_before_sec).toBe(0.71)
    expect(prosody.filler_word_count).toBe(1)
    expect(prosody.speech_rate_wpm).toBe(63.6)
    expect(typeof prosody.speech_rate_wpm).toBe('number')
  })

  it('첫 발화 silence_before_sec=null 은 필드만 null, 객체는 유지 (부분 결측 null-safe)', async () => {
    const { buildProsody } = await internals()
    const prosody = buildProsody({
      ...baseUtt,
      silence_before_sec: null,
      filler_word_count: 0,
      speech_rate_wpm: 61.5,
    } as never)
    expect(prosody).toEqual({
      silence_before_sec: null,
      filler_word_count: 0,
      speech_rate_wpm: 61.5,
    })
  })

  it('세 필드 모두 결측이면 prosody=null (정직한 미산출 노출)', async () => {
    const { buildProsody } = await internals()
    expect(buildProsody({ ...baseUtt } as never)).toBeNull()
    expect(
      buildProsody({ ...baseUtt, silence_before_sec: null, filler_word_count: null, speech_rate_wpm: null } as never),
    ).toBeNull()
  })

  it('buildLabelLine.prosody 가 DB 실값으로 배선된다 (하드코딩 null 아님)', async () => {
    const { buildLabelLine } = await internals()
    const line = buildLabelLine(
      { ...baseUtt, silence_before_sec: 2.12, filler_word_count: 0, speech_rate_wpm: 61.5 } as never,
      'sess1',
      'reference_only',
    )
    expect(line.prosody).toEqual({
      silence_before_sec: 2.12,
      filler_word_count: 0,
      speech_rate_wpm: 61.5,
    })
  })

  it('prosody 미산출 발화는 prosody=null', async () => {
    const { buildLabelLine } = await internals()
    const line = buildLabelLine({ ...baseUtt } as never, 'sess1', 'reference_only')
    expect(line.prosody).toBeNull()
  })
})

describe('export-builder — provenance sanitize (안전선 #6)', () => {
  async function internals() {
    return await import('./export-builder.js').then((m) => m._testInternals)
  }

  it('sanitizeModelVersions: raw 모델명(whisperx/pyannote) → 메서드 enum', async () => {
    const { sanitizeModelVersions } = await internals()
    const out = sanitizeModelVersions({
      stt: 'large-v3',
      align: 'whisperx-align',
      diarization: 'pyannote/speaker-diarization-3.1',
      compute_type: 'int8',
    })
    expect(out).toEqual({
      stt: 'not_available',
      align: 'automatic',
      diarization: 'automatic',
      compute_type: 'not_available',
    })
    expect(JSON.stringify(out).toLowerCase()).not.toMatch(/whisperx|pyannote/)
  })

  it('sanitizeModelVersions: null/비객체 → null', async () => {
    const { sanitizeModelVersions } = await internals()
    expect(sanitizeModelVersions(null)).toBeNull()
    expect(sanitizeModelVersions('large-v3')).toBeNull()
    expect(sanitizeModelVersions([])).toBeNull()
  })

  it('sanitizeVersionString: 인라인 # 주석 + standalone 6+ 숫자 제거', async () => {
    const { sanitizeVersionString } = await internals()
    expect(sanitizeVersionString('v2-largev3-int8  # v2 activation 20260531')).toBe('v2-largev3-int8')
    expect(sanitizeVersionString('2.0.0')).toBe('2.0.0')
    expect(sanitizeVersionString('번호 1234567')).toBe('번호')
    expect(sanitizeVersionString(null)).toBeNull()
    expect(sanitizeVersionString('')).toBeNull()
  })
})

// ── session_speakers 배선: 화자 역할/프로필 ───────────────────────────────
describe('export-builder — session_speakers 배선', () => {
  async function internals() {
    return await import('./export-builder.js').then((m) => m._testInternals)
  }

  const speakerRows = [
    { speaker_label: 'SPEAKER_00', speaker_role: 'self', speaker_gender: 'female', speaker_voice_age_range: '30대' },
    { speaker_label: 'SPEAKER_01', speaker_role: 'other', speaker_gender: 'male', speaker_voice_age_range: '40대', speaker_relation: '교사' },
  ]

  async function lookup() {
    const { buildSpeakerLookup } = await import('../../lib/export/sessionSpeakers.js')
    return buildSpeakerLookup(speakerRows as never[])
  }

  it('buildLabelLine: 룩업으로 speaker_role_candidate 가 unknown 이 아니다', async () => {
    const { buildLabelLine } = await internals()
    const map = await lookup()
    const u = { id: 'u1', sequence_order: 0, speaker_id: 'SPEAKER_00', start_sec: 0, end_sec: 1, transcript_text: 'x' }
    const line = buildLabelLine(u as never, 'sess1', 'reference_only', map)
    expect(line.speaker_role_candidate).toBe('owner_candidate')
  })

  it('buildUtteranceLine: other 화자 → counterparty_candidate', async () => {
    const { buildUtteranceLine } = await internals()
    const map = await lookup()
    const u = { id: 'u2', sequence_order: 1, speaker_id: 'SPEAKER_01', start_sec: 1, end_sec: 2, duration_sec: 1, transcript_text: 'y' }
    const line = buildUtteranceLine(u as never, 'sess1', map)
    expect(line.speaker_role_candidate).toBe('counterparty_candidate')
  })

  it('룩업 미스(IVR/미매핑) → unknown', async () => {
    const { buildLabelLine } = await internals()
    const map = await lookup()
    const u = { id: 'u3', sequence_order: 2, speaker_id: 'SPEAKER_IVR', start_sec: 2, end_sec: 3, transcript_text: 'z' }
    const line = buildLabelLine(u as never, 'sess1', 'reference_only', map)
    expect(line.speaker_role_candidate).toBe('unknown')
  })

  it('buildCallJson: speakers[] 섹션에 estimate 객체 동봉, self/other 단어 미노출', async () => {
    const { buildCallJson } = await internals()
    // 빈도표 미주입 → 관계 K-게이트가 보수적으로 null (단건만으론 K 판정 불가).
    const out = buildCallJson(
      { id: 'sess1', session_quality_tier: null } as never,
      [] as never[],
      'reference_only',
      null,
      speakerRows as never[],
    )
    const speakers = out.speakers as Array<Record<string, unknown>>
    expect(speakers).toHaveLength(2)
    expect((speakers[0].identity_inference as Record<string, unknown>).predicted_role).toBe('owner_candidate')
    expect((speakers[0].gender_estimate as Record<string, unknown>).value).toBe('female')
    expect((speakers[1].age_group_estimate as Record<string, unknown>).voice_age_range).toBe('40대')
    const json = JSON.stringify(out)
    expect(json.toLowerCase()).not.toMatch(/"self"|"other"/) // 안전선 #1
    // 빈도표 없음 → 관계 게이트 null (보수적). 관계값 미노출.
    expect(speakers[1].relation_candidate).toBeNull()
    expect(json).not.toContain('교사')
  })

  it('buildCallJson: 관계 K-게이트 — 흔한값(count>=5)은 원문 relation_candidate 노출', async () => {
    const { buildCallJson } = await internals()
    // 데이터셋 전체 빈도표 주입: 교사=23 (>=5) → 원문 노출(SPEC §4.4 개정).
    const relationFreq = new Map<string, number>([['교사', 23]])
    const out = buildCallJson(
      { id: 'sess1', session_quality_tier: null } as never,
      [] as never[],
      'reference_only',
      null,
      speakerRows as never[],
      relationFreq,
    )
    const speakers = out.speakers as Array<Record<string, unknown>>
    // SPEAKER_00(self측, relation=null) → null
    expect(speakers[0].relation_candidate).toBeNull()
    // SPEAKER_01(상대측, 교사 count 23) → 원문 노출
    const rc = speakers[1].relation_candidate as Record<string, unknown>
    expect(rc.value).toBe('교사')
    expect(rc.generalized).toBe(false)
    expect(rc.method).toBe('heuristic_mvp')
    // 안전선 #1 회귀 없음
    expect(JSON.stringify(out).toLowerCase()).not.toMatch(/"self"|"other"/)
  })

  it('buildCallJson: 화자 메타 부재 시 speakers=[] (날조 금지)', async () => {
    const { buildCallJson } = await internals()
    const out = buildCallJson({ id: 'sess1', session_quality_tier: null } as never, [] as never[], 'reference_only', null, [])
    expect(out.speakers).toEqual([])
  })
})
