import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase
vi.mock('../supabase.js', () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}))

// Mock S3
vi.mock('../s3.js', () => ({
  s3Client: { send: vi.fn() },
  S3_AUDIO_BUCKET: 'test-bucket',
}))

// Mock ffmpeg processor
vi.mock('../audio/ffmpegProcessor.js', () => ({
  detectSilenceBoundaries: vi.fn(),
}))

// Mock fluent-ffmpeg
vi.mock('fluent-ffmpeg', () => {
  const mockFfmpeg = vi.fn().mockReturnValue({
    audioFilters: vi.fn().mockReturnThis(),
    audioFrequency: vi.fn().mockReturnThis(),
    audioChannels: vi.fn().mockReturnThis(),
    audioCodec: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
    on: vi.fn().mockImplementation(function (this: Record<string, unknown>, event: string, cb: () => void) {
      if (event === 'end') {
        setTimeout(cb, 0)
      }
      return this
    }),
    run: vi.fn(),
  })
  mockFfmpeg.setFfmpegPath = vi.fn()
  return { default: mockFfmpeg }
})

import { supabaseAdmin } from '../supabase.js'
import { s3Client } from '../s3.js'
import { detectSilenceBoundaries } from '../audio/ffmpegProcessor.js'
import { validateMaskSync, validateBulk } from './piiMaskSyncService.js'

describe('piiMaskSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('validateMaskSync', () => {
    it('returns no_masks when no [MASKED] tokens exist', async () => {
      // Mock transcript_chunks with no [MASKED] words
      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'transcript_chunks') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [
                    {
                      chunk_index: 0,
                      start_sec: 0,
                      words: [
                        { word: '안녕하세요', start: 0, end: 0.5, probability: 0.95 },
                        { word: '오늘', start: 0.6, end: 0.9, probability: 0.92 },
                      ],
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          } as never
        }
        return {} as never
      })

      const result = await validateMaskSync('sess-1')

      expect(result.syncStatus).toBe('no_masks')
      expect(result.maskedIntervals).toHaveLength(0)
      expect(result.mismatches).toHaveLength(0)
    })

    it('returns synced when masks and beeps align', async () => {
      // Mock transcript_chunks with [MASKED] token
      const mockFrom = vi.mocked(supabaseAdmin.from)
      mockFrom.mockImplementation((table: string) => {
        if (table === 'transcript_chunks') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [
                    {
                      chunk_index: 0,
                      start_sec: 0,
                      words: [
                        { word: '안녕', start: 0, end: 0.3 },
                        { word: '[MASKED]', start: 1.0, end: 2.0 },
                        { word: '감사합니다', start: 2.5, end: 3.0 },
                      ],
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          } as never
        }
        if (table === 'sessions') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { user_id: 'user-1' },
                  error: null,
                }),
              }),
            }),
          } as never
        }
        return {} as never
      })

      // Mock S3 download
      vi.mocked(s3Client.send).mockResolvedValue({
        Body: { transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(100)) },
      } as never)

      // Mock beep detection: detected beep at 1.0-2.0s (matches the [MASKED] interval)
      vi.mocked(detectSilenceBoundaries).mockResolvedValue([
        { start: 1.0, end: 2.0 },
      ])

      const result = await validateMaskSync('sess-1')

      expect(result.syncStatus).toBe('synced')
      expect(result.maskedIntervals).toHaveLength(1)
      expect(result.beepIntervals).toHaveLength(1)
      expect(result.mismatches).toHaveLength(0)
    })

    it('returns mismatch when mask has no matching beep', async () => {
      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'transcript_chunks') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [
                    {
                      chunk_index: 0,
                      start_sec: 0,
                      words: [
                        { word: '[MASKED]', start: 5.0, end: 6.0 },
                      ],
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          } as never
        }
        if (table === 'sessions') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { user_id: 'user-1' },
                  error: null,
                }),
              }),
            }),
          } as never
        }
        return {} as never
      })

      vi.mocked(s3Client.send).mockResolvedValue({
        Body: { transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(100)) },
      } as never)

      // No beep detected at 5.0-6.0s
      vi.mocked(detectSilenceBoundaries).mockResolvedValue([
        { start: 10.0, end: 11.0 }, // beep elsewhere
      ])

      const result = await validateMaskSync('sess-1')

      expect(result.syncStatus).toBe('mismatch')
      expect(result.mismatches).toHaveLength(2) // mask_without_beep + beep_without_mask
      expect(result.mismatches[0].type).toBe('mask_without_beep')
      expect(result.mismatches[1].type).toBe('beep_without_mask')
    })

    it('returns error when session not found', async () => {
      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'transcript_chunks') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [
                    {
                      chunk_index: 0,
                      start_sec: 0,
                      words: [{ word: '[MASKED]', start: 1.0, end: 2.0 }],
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          } as never
        }
        if (table === 'sessions') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: null,
                  error: { message: 'not found' },
                }),
              }),
            }),
          } as never
        }
        return {} as never
      })

      const result = await validateMaskSync('missing-session')

      expect(result.syncStatus).toBe('error')
      expect(result.summary).toContain('not found')
    })
  })

  describe('validateBulk', () => {
    it('processes multiple sessions and captures errors', async () => {
      let callCount = 0
      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === 'transcript_chunks') {
          callCount++
          if (callCount === 1) {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockResolvedValue({
                    data: [{ chunk_index: 0, start_sec: 0, words: [] }],
                    error: null,
                  }),
                }),
              }),
            } as never
          }
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockRejectedValue(new Error('DB timeout')),
              }),
            }),
          } as never
        }
        return {} as never
      })

      const results = await validateBulk(['sess-ok', 'sess-fail'])

      expect(results).toHaveLength(2)
      expect(results[0].syncStatus).toBe('no_masks')
      expect(results[1].syncStatus).toBe('error')
      expect(results[1].summary).toContain('DB timeout')
    })
  })
})
