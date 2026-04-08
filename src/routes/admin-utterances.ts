// ── Admin Utterances API Routes ─────────────────────────────────────────
// PII 수동 비식별화 검수용 어드민 전용 엔드포인트

import { Hono } from 'hono'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, unlink, mkdir } from 'fs/promises'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware, getBody } from '../lib/middleware.js'
import { getSignedUrl, uploadObject, S3_AUDIO_BUCKET, s3Client } from '../lib/s3.js'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const adminUtterances = new Hono()

// 인증 + 어드민 권한 필수
adminUtterances.use('/*', authMiddleware)
adminUtterances.use('/*', adminMiddleware)

/**
 * GET /admin/utterances/:id/audio
 * 발화 WAV signed URL 반환
 */
adminUtterances.get('/utterances/:id/audio', async (c) => {
  const utteranceId = c.req.param('id')

  try {
    const { data, error } = await supabaseAdmin
      .from('utterances')
      .select('storage_path')
      .eq('id', utteranceId)
      .single()

    if (error || !data) {
      return c.json({ error: 'Utterance not found' }, 404)
    }

    if (!data.storage_path) {
      return c.json({ error: 'No audio file for this utterance' }, 404)
    }

    const signedUrl = await getSignedUrl(S3_AUDIO_BUCKET, data.storage_path, 3600)

    return c.json({ signedUrl })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /admin/utterances/:id/pii
 * 기존 PII 자동 감지 결과 조회
 */
adminUtterances.get('/utterances/:id/pii', async (c) => {
  const utteranceId = c.req.param('id')

  try {
    const { data, error } = await supabaseAdmin
      .from('utterances')
      .select('pii_intervals, pii_reviewed_at, pii_reviewed_by')
      .eq('id', utteranceId)
      .single()

    if (error || !data) {
      return c.json({ error: 'Utterance not found' }, 404)
    }

    return c.json({
      piiIntervals: data.pii_intervals ?? [],
      piiReviewedAt: data.pii_reviewed_at,
      piiReviewedBy: data.pii_reviewed_by,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * PUT /admin/utterances/:id/pii
 * 수동 PII 구간 저장
 * Body: { piiIntervals: [{startSec, endSec, maskType, piiType, piiDetail}] }
 */
adminUtterances.put('/utterances/:id/pii', async (c) => {
  const utteranceId = c.req.param('id')
  const userId = c.get('userId') as string
  const { piiIntervals } = getBody<{
    piiIntervals: Array<{
      startSec: number
      endSec: number
      maskType: string
      piiType: string
      piiDetail?: string
    }>
  }>(c)

  if (!Array.isArray(piiIntervals)) {
    return c.json({ error: 'piiIntervals must be an array' }, 400)
  }

  // piiIntervals 각 원소 필수 필드 검증
  for (const interval of piiIntervals) {
    if (typeof interval.startSec !== 'number' || typeof interval.endSec !== 'number') {
      return c.json({ error: 'Invalid PII interval: startSec and endSec must be numbers' }, 400)
    }
    if (typeof interval.maskType !== 'string' || typeof interval.piiType !== 'string') {
      return c.json({ error: 'Invalid PII interval: maskType and piiType must be strings' }, 400)
    }
  }

  try {
    const { error } = await supabaseAdmin
      .from('utterances')
      .update({
        pii_intervals: piiIntervals,
        pii_reviewed_at: new Date().toISOString(),
        pii_reviewed_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', utteranceId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { ok: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /admin/utterances/:id/apply-mask
 * 마스킹 실행 — S3에서 WAV 다운로드 → FFmpeg beep/무음 삽입 → 재업로드
 * Body: { maskType?: 'beep' | 'silence' } (default: 'beep')
 */
adminUtterances.post('/utterances/:id/apply-mask', async (c) => {
  const utteranceId = c.req.param('id')
  const { maskType = 'beep' } = getBody<{ maskType?: 'beep' | 'silence' }>(c)

  try {
    const { data: utt, error: fetchError } = await supabaseAdmin
      .from('utterances')
      .select('storage_path, pii_intervals')
      .eq('id', utteranceId)
      .single()

    if (fetchError || !utt) {
      return c.json({ error: 'Utterance not found' }, 404)
    }

    if (!utt.storage_path) {
      return c.json({ error: 'No audio file for this utterance' }, 404)
    }

    const intervals = utt.pii_intervals as Array<{ startSec: number; endSec: number }> | null
    if (!intervals || intervals.length === 0) {
      return c.json({ error: 'No PII intervals to mask' }, 400)
    }

    // PII 구간 숫자 검증 (command injection 방지)
    for (const interval of intervals) {
      if (typeof interval.startSec !== 'number' || typeof interval.endSec !== 'number') {
        return c.json({ error: 'Invalid PII interval: startSec and endSec must be numbers' }, 400)
      }
    }

    // Download WAV from S3
    const tempDir = join(tmpdir(), `pii-mask-${Date.now()}`)
    await mkdir(tempDir, { recursive: true })
    const inputPath = join(tempDir, 'input.wav')
    const outputPath = join(tempDir, 'output.wav')

    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: S3_AUDIO_BUCKET, Key: utt.storage_path }),
    )
    if (!response.Body) {
      return c.json({ error: 'Failed to download audio' }, 500)
    }
    const bytes = await response.Body.transformToByteArray()
    await writeFile(inputPath, bytes)

    // Build FFmpeg filter for masking
    const filters = intervals.map((interval) => {
      const { startSec, endSec } = interval
      if (maskType === 'silence') {
        return `volume=enable='between(t,${startSec},${endSec})':volume=0`
      }
      // beep: 1kHz sine wave overlay
      return `volume=enable='between(t,${startSec},${endSec})':volume=0`
    })

    if (maskType === 'beep') {
      // Generate beep overlay for each interval and mix
      const beepFilters = intervals.map((interval, i) => {
        const duration = interval.endSec - interval.startSec
        return `sine=frequency=1000:duration=${duration}:sample_rate=16000,adelay=${Math.round(interval.startSec * 1000)}|${Math.round(interval.startSec * 1000)},apad=whole_dur=0[beep${i}]`
      })
      const mixInputs = intervals.map((_, i) => `[beep${i}]`).join('')
      const silenceFilter = intervals
        .map((interval) => `volume=enable='between(t,${interval.startSec},${interval.endSec})':volume=0`)
        .join(',')

      const filterComplex = [
        `[0:a]${silenceFilter}[silenced]`,
        ...beepFilters,
        `[silenced]${mixInputs}amix=inputs=${intervals.length + 1}:duration=first[out]`,
      ].join(';')

      await execFileAsync('ffmpeg', [
        '-y', '-i', inputPath,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        outputPath,
      ])
    } else {
      // Silence masking
      const silenceFilter = filters.join(',')
      await execFileAsync('ffmpeg', [
        '-y', '-i', inputPath,
        '-af', silenceFilter,
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        outputPath,
      ])
    }

    // Upload masked WAV back to S3 (same path)
    const { readFile } = await import('fs/promises')
    const maskedBytes = await readFile(outputPath)
    await uploadObject(S3_AUDIO_BUCKET, utt.storage_path, maskedBytes, 'audio/wav')

    // Update file size
    await supabaseAdmin
      .from('utterances')
      .update({
        file_size_bytes: maskedBytes.byteLength,
        updated_at: new Date().toISOString(),
      })
      .eq('id', utteranceId)

    // Cleanup temp files
    try {
      await unlink(inputPath)
      await unlink(outputPath)
    } catch {
      // ignore cleanup errors
    }

    return c.json({ data: { ok: true, maskType, intervalsProcessed: intervals.length } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default adminUtterances
