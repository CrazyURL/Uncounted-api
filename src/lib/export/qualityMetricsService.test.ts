import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase before imports
vi.mock('../supabase.js', () => ({
  supabaseAdmin: {
    from: vi.fn().mockReturnValue({
      upsert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }),
  },
}))

// Mock S3
vi.mock('../s3.js', () => ({
  s3Client: {
    send: vi.fn(),
  },
  S3_AUDIO_BUCKET: 'test-bucket',
}))

// Mock ffmpegProcessor
vi.mock('../audio/ffmpegProcessor.js', () => ({
  getAudioStats: vi.fn(),
}))

import { s3Client } from '../s3.js'
import { getAudioStats } from '../audio/ffmpegProcessor.js'
import { supabaseAdmin } from '../supabase.js'

describe('qualityMetricsService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('analyzeSessionQuality', () => {
    it('downloads WAV, analyzes, and saves metrics', async () => {
      // Mock S3 download
      const mockBody = {
        transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(100)),
      }
      vi.mocked(s3Client.send).mockResolvedValue({ Body: mockBody } as never)

      // Mock audio stats
      vi.mocked(getAudioStats).mockResolvedValue({
        durationSec: 120,
        rmsDb: -20,
        peakDb: -3,
        silenceRatio: 0.1,
      })

      // Mock upsert response
      const mockMetrics = [
        {
          id: 'uuid-1',
          session_id: 'sess-1',
          bu_index: 0,
          user_id: 'user-1',
          snr_db: 17,
          speech_ratio: 0.9,
          clipping_ratio: 0,
          beep_mask_ratio: null,
          volume_lufs: -20,
          quality_score: 75,
          quality_grade: 'B',
          analyzed_at: '2026-04-06T00:00:00Z',
        },
        {
          id: 'uuid-2',
          session_id: 'sess-1',
          bu_index: 1,
          user_id: 'user-1',
          snr_db: 17,
          speech_ratio: 0.9,
          clipping_ratio: 0,
          beep_mask_ratio: null,
          volume_lufs: -20,
          quality_score: 75,
          quality_grade: 'B',
          analyzed_at: '2026-04-06T00:00:00Z',
        },
      ]

      const mockUpsert = vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: mockMetrics, error: null }),
      })
      const mockUpdate = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      })

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'bu_quality_metrics') {
          return { upsert: mockUpsert } as never
        }
        if (table === 'billable_units') {
          return { update: mockUpdate } as never
        }
        return {} as never
      })

      // Dynamic import to apply mocks
      const { analyzeSessionQuality } = await import('./qualityMetricsService.js')

      const result = await analyzeSessionQuality('sess-1', 'user-1')

      expect(result.sessionId).toBe('sess-1')
      expect(result.userId).toBe('user-1')
      expect(result.metrics).toHaveLength(2)

      // Verify S3 download was called
      expect(s3Client.send).toHaveBeenCalledOnce()

      // Verify audio analysis was called
      expect(getAudioStats).toHaveBeenCalledOnce()

      // Verify upsert was called with 2 BU entries (120s = 2 minutes)
      expect(mockUpsert).toHaveBeenCalledOnce()
      const upsertArgs = mockUpsert.mock.calls[0]
      expect(upsertArgs[0]).toHaveLength(2)
      expect(upsertArgs[0][0].bu_index).toBe(0)
      expect(upsertArgs[0][1].bu_index).toBe(1)
    })
  })

  describe('analyzeBulk', () => {
    it('processes multiple sessions and continues on error', async () => {
      vi.mocked(s3Client.send)
        .mockResolvedValueOnce({
          Body: { transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(50)) },
        } as never)
        .mockRejectedValueOnce(new Error('S3 not found'))
        .mockResolvedValueOnce({
          Body: { transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(50)) },
        } as never)

      vi.mocked(getAudioStats)
        .mockResolvedValueOnce({
          durationSec: 30,
          rmsDb: -18,
          peakDb: -2,
          silenceRatio: 0.05,
        })
        .mockResolvedValueOnce({
          durationSec: 45,
          rmsDb: -22,
          peakDb: -5,
          silenceRatio: 0.2,
        })

      const mockMetric = {
        id: 'uuid-x',
        session_id: 's',
        bu_index: 0,
        user_id: 'u',
        snr_db: 16,
        speech_ratio: 0.95,
        clipping_ratio: 0,
        beep_mask_ratio: null,
        volume_lufs: -18,
        quality_score: 80,
        quality_grade: 'A',
        analyzed_at: '2026-04-06T00:00:00Z',
      }

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'bu_quality_metrics') {
          return {
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({ data: [mockMetric], error: null }),
            }),
          } as never
        }
        if (table === 'billable_units') {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          } as never
        }
        return {} as never
      })

      const { analyzeBulk } = await import('./qualityMetricsService.js')

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const results = await analyzeBulk([
        { sessionId: 's1', userId: 'u1' },
        { sessionId: 's2', userId: 'u2' }, // will fail
        { sessionId: 's3', userId: 'u3' },
      ])

      // 2 succeeded, 1 failed (s2)
      expect(results).toHaveLength(2)
      expect(consoleSpy).toHaveBeenCalledOnce()

      consoleSpy.mockRestore()
    })
  })
})

describe('qualityMetricsRepository', () => {
  it('exports expected functions', async () => {
    const repo = await import('./qualityMetricsRepository.js')
    expect(repo.upsertQualityMetrics).toBeTypeOf('function')
    expect(repo.upsertQualityMetricsBatch).toBeTypeOf('function')
    expect(repo.getQualityMetricsBySession).toBeTypeOf('function')
    expect(repo.getQualityMetricsBySessions).toBeTypeOf('function')
    expect(repo.deleteQualityMetricsBySession).toBeTypeOf('function')
  })
})
