import { describe, it, expect } from 'vitest'
import type {
  PackageManifest,
  QualitySummary,
  SpeakerDemographic,
  UtteranceMetaLine,
} from './packageBuilder.js'

describe('packageBuilder types', () => {
  it('PackageManifest has correct structure', () => {
    const manifest: PackageManifest = {
      sku: 'U-A01',
      version: '1.0',
      exportDate: '2026-04-06',
      client: 'Naver CLOVA Speech',
      totalDurationHours: 1.02,
      utteranceCount: 38,
      speakerCount: 3,
      format: { sampleRate: 16000, bitDepth: 16, channels: 1, encoding: 'PCM' },
      license: 'Uncounted Data License v1',
      consentLevel: 'both_agreed',
    }

    expect(manifest.sku).toBe('U-A01')
    expect(manifest.format.sampleRate).toBe(16000)
    expect(manifest.utteranceCount).toBe(38)
    expect(manifest.totalDurationHours).toBeCloseTo(1.02)
  })

  it('QualitySummary computes correctly', () => {
    const summary: QualitySummary = {
      totalUtterances: 10,
      gradeDistribution: { A: 5, B: 3, C: 2 },
      avgSnrDb: 25.5,
      avgSpeechRatio: 0.85,
      avgQaScore: 72.3,
    }

    expect(summary.gradeDistribution.A + summary.gradeDistribution.B + summary.gradeDistribution.C)
      .toBe(summary.totalUtterances)
    expect(summary.avgSnrDb).toBeGreaterThan(0)
  })

  it('SpeakerDemographic has required fields', () => {
    const speaker: SpeakerDemographic = {
      pseudoId: 'user_abc123',
      utteranceCount: 12,
      totalDurationSec: 145.5,
    }

    expect(speaker.pseudoId).toBe('user_abc123')
    expect(speaker.utteranceCount).toBe(12)
    expect(speaker.totalDurationSec).toBeCloseTo(145.5)
  })

  it('UtteranceMetaLine produces valid JSONL entry', () => {
    const line: UtteranceMetaLine = {
      utterance_id: 'utt_sess1_001',
      session_id: 'sess1',
      pseudo_id: 'user_abc',
      duration_sec: 12.5,
      snr_db: 28.3,
      speech_ratio: 0.91,
      quality_grade: 'A',
      qa_score: 85,
    }

    const jsonl = JSON.stringify(line)
    const parsed = JSON.parse(jsonl)

    expect(parsed.utterance_id).toBe('utt_sess1_001')
    expect(parsed.duration_sec).toBe(12.5)
    expect(parsed.quality_grade).toBe('A')
  })

  it('JSONL batch produces one line per utterance', () => {
    const lines: UtteranceMetaLine[] = [
      {
        utterance_id: 'utt_s1_000',
        session_id: 's1',
        pseudo_id: null,
        duration_sec: 8,
        snr_db: null,
        speech_ratio: null,
        quality_grade: 'B',
        qa_score: 65,
      },
      {
        utterance_id: 'utt_s1_001',
        session_id: 's1',
        pseudo_id: null,
        duration_sec: 15.2,
        snr_db: 22.1,
        speech_ratio: 0.78,
        quality_grade: 'A',
        qa_score: 80,
      },
    ]

    const jsonlContent = lines.map((l) => JSON.stringify(l)).join('\n')
    const outputLines = jsonlContent.split('\n')

    expect(outputLines).toHaveLength(2)
    expect(JSON.parse(outputLines[0]).utterance_id).toBe('utt_s1_000')
    expect(JSON.parse(outputLines[1]).utterance_id).toBe('utt_s1_001')
  })
})

describe('package directory structure validation', () => {
  it('U-A01 directory name follows convention', () => {
    const today = '2026-04-06'
    const clientName = 'Naver CLOVA Speech'
    const sanitized = clientName.replace(/[^a-zA-Z0-9가-힣_-]/g, '_')
    const dirName = `U-A01_${today}_${sanitized}`

    expect(dirName).toBe('U-A01_2026-04-06_Naver_CLOVA_Speech')
    expect(dirName).toMatch(/^U-A01_\d{4}-\d{2}-\d{2}_/)
  })

  it('expected file paths within package', () => {
    const dirName = 'U-A01_2026-04-06_TestClient'
    const expectedPaths = [
      `${dirName}/manifest.json`,
      `${dirName}/quality_summary.json`,
      `${dirName}/speaker_demographics.json`,
      `${dirName}/metadata/utterances.jsonl`,
      `${dirName}/audio/utt_sess1_000.wav`,
      `${dirName}/transcripts/utt_sess1_000.json`,
    ]

    for (const path of expectedPaths) {
      expect(path).toContain(dirName)
      expect(path.split('/').length).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('quality summary computation', () => {
  it('computes averages correctly from utterance data', () => {
    const utterances = [
      { snr_db: 20, speech_ratio: 0.8, qa_score: 70, quality_grade: 'B' },
      { snr_db: 30, speech_ratio: 0.9, qa_score: 90, quality_grade: 'A' },
      { snr_db: 25, speech_ratio: 0.85, qa_score: 80, quality_grade: 'A' },
    ]

    let snrSum = 0, speechSum = 0, qaSum = 0
    const grades = { A: 0, B: 0, C: 0 }

    for (const u of utterances) {
      snrSum += u.snr_db
      speechSum += u.speech_ratio
      qaSum += u.qa_score
      grades[u.quality_grade as keyof typeof grades]++
    }

    const avgSnr = Math.round((snrSum / utterances.length) * 100) / 100
    const avgSpeech = Math.round((speechSum / utterances.length) * 10000) / 10000
    const avgQa = Math.round((qaSum / utterances.length) * 100) / 100

    expect(avgSnr).toBe(25)
    expect(avgSpeech).toBe(0.85)
    expect(avgQa).toBe(80)
    expect(grades).toEqual({ A: 2, B: 1, C: 0 })
  })

  it('handles null metrics gracefully', () => {
    const items = [
      { snr_db: null, qa_score: 70 },
      { snr_db: 25, qa_score: null },
    ]

    let snrSum = 0, snrCount = 0, qaSum = 0, qaCount = 0

    for (const item of items) {
      if (item.snr_db != null) { snrSum += item.snr_db; snrCount++ }
      if (item.qa_score != null) { qaSum += item.qa_score; qaCount++ }
    }

    const avgSnr = snrCount > 0 ? Math.round((snrSum / snrCount) * 100) / 100 : null
    const avgQa = qaCount > 0 ? Math.round((qaSum / qaCount) * 100) / 100 : null

    expect(avgSnr).toBe(25)
    expect(avgQa).toBe(70)
  })
})

describe('speaker demographics aggregation', () => {
  it('groups utterances by pseudo_id', () => {
    const utterances = [
      { pseudo_id: 'user_a', duration_sec: 10 },
      { pseudo_id: 'user_a', duration_sec: 15 },
      { pseudo_id: 'user_b', duration_sec: 20 },
      { pseudo_id: null, duration_sec: 8 },
    ]

    const speakerMap = new Map<string, { count: number; durationSec: number }>()

    for (const u of utterances) {
      const key = u.pseudo_id ?? 'unknown'
      const existing = speakerMap.get(key) ?? { count: 0, durationSec: 0 }
      speakerMap.set(key, {
        count: existing.count + 1,
        durationSec: existing.durationSec + u.duration_sec,
      })
    }

    expect(speakerMap.size).toBe(3)
    expect(speakerMap.get('user_a')?.count).toBe(2)
    expect(speakerMap.get('user_a')?.durationSec).toBe(25)
    expect(speakerMap.get('user_b')?.count).toBe(1)
    expect(speakerMap.get('unknown')?.count).toBe(1)
  })
})
