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
import { validatePiiIntervals } from './admin-utterances-helpers.js'
import { isUtteranceDeliverable } from '../lib/export/utteranceDeliverability.js'

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
 * GET /admin/utterances/:id/audio/stream
 * WAV 바이너리 프록시 (wavesurfer.js CORS 우회)
 */
adminUtterances.get('/utterances/:id/audio/stream', async (c) => {
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

    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: S3_AUDIO_BUCKET, Key: data.storage_path }),
    )
    if (!response.Body) {
      return c.json({ error: 'Failed to download audio' }, 500)
    }

    const bytes = await response.Body.transformToByteArray()

    c.header('Content-Type', 'audio/wav')
    c.header('Content-Length', String(bytes.byteLength))
    // no-store: 마스킹 적용 후 동일 URL에 대한 캐시 히트로 원본이 보이는 버그 방지
    c.header('Cache-Control', 'no-store')
    return c.body(bytes.buffer as ArrayBuffer)
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
      .select('pii_intervals, pii_reviewed_at, pii_reviewed_by, pii_masked, pii_masked_at, pii_masked_by, pii_masked_by_email, pii_mask_version')
      .eq('id', utteranceId)
      .single()

    if (error || !data) {
      return c.json({ error: 'Utterance not found' }, 404)
    }

    return c.json({
      data: {
        piiIntervals: data.pii_intervals ?? [],
        piiReviewedAt: data.pii_reviewed_at,
        piiReviewedBy: data.pii_reviewed_by,
        piiMasked: data.pii_masked === true,
        piiMaskedAt: data.pii_masked_at,
        piiMaskedBy: data.pii_masked_by,
        piiMaskedByEmail: data.pii_masked_by_email,
        piiMaskVersion: data.pii_mask_version ?? 0,
      },
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

  const validationError = validatePiiIntervals(piiIntervals)
  if (validationError !== null) {
    return c.json({ error: validationError }, 400)
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
 * PATCH /admin/utterances/:id/review-status
 * 단건 검수 상태 즉시 저장 (검수 화면에서 토글마다 호출)
 * Body: { isIncluded: boolean, excludeReason?: string }
 */
adminUtterances.patch('/utterances/:id/review-status', async (c) => {
  const utteranceId = c.req.param('id')
  const userId = c.get('userId') as string
  const { isIncluded, excludeReason } = getBody<{
    isIncluded: boolean
    excludeReason?: string
  }>(c)

  if (typeof isIncluded !== 'boolean') {
    return c.json({ error: 'isIncluded must be boolean' }, 400)
  }

  try {
    const now = new Date().toISOString()
    const { error } = await supabaseAdmin
      .from('utterances')
      .update({
        review_status: isIncluded ? 'pending' : 'excluded',
        exclude_reason: isIncluded ? null : (excludeReason ?? 'manual'),
        reviewed_at: now,
        reviewed_by: userId,
        updated_at: now,
      })
      .eq('id', utteranceId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { ok: true, isIncluded } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * PATCH /admin/utterances/review-status/batch
 * 다건 검수 상태 일괄 저장 (벌크 선택/자동필터에서 호출)
 * Body: { updates: Array<{ utteranceId: string, isIncluded: boolean, excludeReason?: string }> }
 */
adminUtterances.patch('/utterances/review-status/batch', async (c) => {
  const userId = c.get('userId') as string
  const { updates } = getBody<{
    updates: Array<{ utteranceId: string; isIncluded: boolean; excludeReason?: string }>
  }>(c)

  if (!Array.isArray(updates) || updates.length === 0) {
    return c.json({ error: 'updates must be a non-empty array' }, 400)
  }

  if (updates.length > 2000) {
    return c.json({ error: 'Maximum 2000 updates per batch' }, 400)
  }

  const now = new Date().toISOString()
  const failures: string[] = []

  await Promise.all(
    updates.map(async ({ utteranceId, isIncluded, excludeReason }) => {
      try {
        const { error } = await supabaseAdmin
          .from('utterances')
          .update({
            review_status: isIncluded ? 'pending' : 'excluded',
            exclude_reason: isIncluded ? null : (excludeReason ?? 'manual'),
            reviewed_at: now,
            reviewed_by: userId,
            updated_at: now,
          })
          .eq('id', utteranceId)

        if (error) failures.push(utteranceId)
      } catch {
        failures.push(utteranceId)
      }
    })
  )

  return c.json({
    data: {
      ok: failures.length === 0,
      total: updates.length,
      succeeded: updates.length - failures.length,
      failed: failures.length,
      failures,
    },
  })
})

/**
 * GET /admin/utterances/:id/preview-mask
 * PII 구간을 무음 처리한 미리보기 WAV 반환 (DB 변경 없음)
 */
adminUtterances.get('/utterances/:id/preview-mask', async (c) => {
  const utteranceId = c.req.param('id')

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

    const intervals = utt.pii_intervals as Array<{ startSec: number; endSec: number; maskType?: string }> | null
    if (!intervals || intervals.length === 0) {
      return c.json({ error: 'No PII intervals to preview' }, 400)
    }

    const previewValidationError = validatePiiIntervals(intervals)
    if (previewValidationError !== null) {
      return c.json({ error: previewValidationError }, 400)
    }

    const tempDir = join(tmpdir(), `pii-preview-${Date.now()}`)
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

    const beepIntervals = intervals.filter(i => (i.maskType ?? 'beep') !== 'silence')

    // 전체 구간 무음 처리 (silence + beep 모두)
    const silenceFilter = intervals
      .map((interval) => `volume=enable='between(t,${interval.startSec},${interval.endSec})':volume=0`)
      .join(',')

    if (beepIntervals.length > 0) {
      // beep 구간에 sine wave 오버레이
      const beepFilters = beepIntervals.map((interval, i) => {
        const duration = interval.endSec - interval.startSec
        return `sine=frequency=1000:duration=${duration}:sample_rate=16000,adelay=${Math.round(interval.startSec * 1000)}|${Math.round(interval.startSec * 1000)},apad=pad_dur=300[beep${i}]`
      })
      const mixInputs = beepIntervals.map((_, i) => `[beep${i}]`).join('')

      const filterComplex = [
        `[0:a]${silenceFilter}[silenced]`,
        ...beepFilters,
        `[silenced]${mixInputs}amix=inputs=${beepIntervals.length + 1}:duration=first:normalize=0[out]`,
      ].join(';')

      await execFileAsync('ffmpeg', [
        '-y', '-i', inputPath,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        outputPath,
      ])
    } else {
      await execFileAsync('ffmpeg', [
        '-y', '-i', inputPath,
        '-af', silenceFilter,
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        outputPath,
      ])
    }

    const { readFile } = await import('fs/promises')
    const previewBytes = await readFile(outputPath)

    try {
      await unlink(inputPath)
      await unlink(outputPath)
    } catch {
      // ignore cleanup errors
    }

    c.header('Content-Type', 'audio/wav')
    c.header('Content-Disposition', `inline; filename="preview_${utteranceId}.wav"`)
    return c.body(previewBytes.buffer as ArrayBuffer)
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
  const { maskType = 'beep', jobId } = getBody<{ maskType?: 'beep' | 'silence'; jobId?: string }>(c)
  const adminUser = (c.get as (key: string) => unknown)('user') as { id: string; email?: string } | undefined

  try {
    const { data: utt, error: fetchError } = await supabaseAdmin
      .from('utterances')
      .select('storage_path, pii_intervals, session_id, user_id, pii_mask_version')
      .eq('id', utteranceId)
      .single()

    if (fetchError || !utt) {
      return c.json({ error: 'Utterance not found' }, 404)
    }

    if (!utt.storage_path) {
      return c.json({ error: 'No audio file for this utterance' }, 404)
    }

    const intervals = utt.pii_intervals as Array<{ startSec: number; endSec: number; maskType?: string }> | null
    if (!intervals || intervals.length === 0) {
      return c.json({ error: 'No PII intervals to mask' }, 400)
    }

    // PII 구간 숫자 검증 (NaN/Infinity 포함 command injection 방지)
    const applyValidationError = validatePiiIntervals(intervals)
    if (applyValidationError !== null) {
      return c.json({ error: applyValidationError }, 400)
    }

    // Download WAV from S3 — 재적용 시 원본 백업에서 읽어야 이전 마스킹 덮어쓰기 가능
    const tempDir = join(tmpdir(), `pii-mask-${Date.now()}`)
    await mkdir(tempDir, { recursive: true })
    const inputPath = join(tempDir, 'input.wav')
    const outputPath = join(tempDir, 'output.wav')

    const backupPath = `${utt.session_id}/original/${utteranceId}.wav`
    let sourceKey = utt.storage_path
    try {
      const backupHead = await s3Client.send(
        new GetObjectCommand({ Bucket: S3_AUDIO_BUCKET, Key: backupPath }),
      )
      if (backupHead.Body) sourceKey = backupPath
    } catch {
      // 백업 없으면 최초 적용 — storage_path 사용
    }

    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: S3_AUDIO_BUCKET, Key: sourceKey }),
    )
    if (!response.Body) {
      return c.json({ error: 'Failed to download audio' }, 500)
    }
    const bytes = await response.Body.transformToByteArray()
    await writeFile(inputPath, bytes)

    // per-interval maskType 사용 (DB에 저장된 값 우선, 없으면 body 파라미터 폴백)
    const beepIntervals = intervals.filter(i => (i.maskType ?? maskType) !== 'silence')

    // 전체 구간 무음 처리 (silence + beep 모두)
    const silenceFilter = intervals
      .map(i => `volume=enable='between(t,${i.startSec},${i.endSec})':volume=0`)
      .join(',')

    if (beepIntervals.length > 0) {
      // beep 구간에만 sine wave 오버레이
      const beepFilters = beepIntervals.map((interval, i) => {
        const duration = interval.endSec - interval.startSec
        return `sine=frequency=1000:duration=${duration}:sample_rate=16000,adelay=${Math.round(interval.startSec * 1000)}|${Math.round(interval.startSec * 1000)},apad=pad_dur=300[beep${i}]`
      })
      const mixInputs = beepIntervals.map((_, i) => `[beep${i}]`).join('')

      const filterComplex = [
        `[0:a]${silenceFilter}[silenced]`,
        ...beepFilters,
        `[silenced]${mixInputs}amix=inputs=${beepIntervals.length + 1}:duration=first:normalize=0[out]`,
      ].join(';')

      await execFileAsync('ffmpeg', [
        '-y', '-i', inputPath,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        outputPath,
      ])
    } else {
      // 전체 무음 처리
      await execFileAsync('ffmpeg', [
        '-y', '-i', inputPath,
        '-af', silenceFilter,
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        outputPath,
      ])
    }

    // Upload masked WAV back to S3: backup original first, then overwrite
    const { readFile } = await import('fs/promises')
    const maskedBytes = await readFile(outputPath)
    await uploadObject(S3_AUDIO_BUCKET, backupPath, bytes, 'audio/wav')
    await uploadObject(S3_AUDIO_BUCKET, utt.storage_path, maskedBytes, 'audio/wav')

    // Update file size + 마스킹 감사 메타
    const nextVersion = ((utt.pii_mask_version as number | null) ?? 0) + 1
    const maskedAt = new Date().toISOString()
    const { data: updatedRow, error: updateError } = await supabaseAdmin
      .from('utterances')
      .update({
        file_size_bytes: maskedBytes.byteLength,
        pii_masked: true,
        pii_masked_at: maskedAt,
        pii_masked_by: adminUser?.id ?? null,
        pii_masked_by_email: adminUser?.email ?? null,
        pii_mask_version: nextVersion,
        updated_at: maskedAt,
      })
      .eq('id', utteranceId)
      .select('id, pii_masked, pii_masked_at, pii_masked_by, pii_masked_by_email, pii_mask_version')
      .single()

    if (updateError) {
      console.error('[apply-mask] DB update failed:', updateError)
      return c.json({ error: `DB update failed: ${updateError.message}` }, 500)
    }
    if (!updatedRow) {
      console.error('[apply-mask] DB update returned no row for', utteranceId)
      return c.json({ error: 'Utterance row not found after update' }, 500)
    }

    // 작업 로그 타임라인 기록 (jobId가 전달된 경우만)
    if (jobId) {
      try {
        const { data: job } = await supabaseAdmin
          .from('export_jobs')
          .select('logs')
          .eq('id', jobId)
          .single()
        if (job) {
          const logEntry = {
            timestamp: maskedAt,
            level: 'info',
            message: `PII 마스킹 적용 — utt_${utteranceId.slice(0, 8)} (구간 ${intervals.length}건, v${nextVersion}) by ${adminUser?.email ?? adminUser?.id ?? 'unknown'}`,
          }
          const logs = Array.isArray(job.logs) ? [...job.logs, logEntry] : [logEntry]
          await supabaseAdmin.from('export_jobs').update({ logs }).eq('id', jobId)
        }
      } catch (logErr) {
        console.error('[apply-mask] job log append failed:', logErr)
      }
    }

    // Cleanup temp files
    try {
      await unlink(inputPath)
      await unlink(outputPath)
    } catch {
      // ignore cleanup errors
    }

    return c.json({
      data: {
        ok: true,
        intervalsProcessed: intervals.length,
        piiMasked: true,
        piiMaskedAt: maskedAt,
        piiMaskedBy: adminUser?.id ?? null,
        piiMaskedByEmail: adminUser?.email ?? null,
        piiMaskVersion: nextVersion,
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /admin/utterances/:id/original-backup
 * 원본 백업 존재 여부 확인
 */
adminUtterances.get('/utterances/:id/original-backup', async (c) => {
  const utteranceId = c.req.param('id')

  try {
    const { data, error } = await supabaseAdmin
      .from('utterances')
      .select('storage_path, session_id, user_id')
      .eq('id', utteranceId)
      .single()

    if (error || !data) {
      return c.json({ error: 'Utterance not found' }, 404)
    }

    const backupPath = `${data.session_id}/original/${utteranceId}.wav`

    try {
      await s3Client.send(new GetObjectCommand({ Bucket: S3_AUDIO_BUCKET, Key: backupPath }))
      return c.json({ data: { hasBackup: true } })
    } catch {
      return c.json({ data: { hasBackup: false } })
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /admin/utterances/:id/restore-original
 * S3 원본 백업을 storage_path로 복원
 */
adminUtterances.post('/utterances/:id/restore-original', async (c) => {
  const utteranceId = c.req.param('id')

  try {
    const { data: utt, error: fetchError } = await supabaseAdmin
      .from('utterances')
      .select('storage_path, session_id, user_id')
      .eq('id', utteranceId)
      .single()

    if (fetchError || !utt) {
      return c.json({ error: 'Utterance not found' }, 404)
    }

    const backupPath = `${utt.session_id}/original/${utteranceId}.wav`

    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: S3_AUDIO_BUCKET, Key: backupPath }),
    )
    if (!response.Body) {
      return c.json({ error: 'Original backup not found' }, 404)
    }

    const bytes = await response.Body.transformToByteArray()
    await uploadObject(S3_AUDIO_BUCKET, utt.storage_path, bytes, 'audio/wav')

    await supabaseAdmin
      .from('utterances')
      .update({
        file_size_bytes: bytes.byteLength,
        pii_masked: false,
        pii_masked_at: null,
        pii_masked_by: null,
        pii_masked_by_email: null,
        pii_mask_version: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', utteranceId)

    return c.json({ data: { ok: true } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /admin/utterances/labels
 * 발화 라벨 배치 저장 (U-A02 / U-A03)
 * Body: { utteranceIds: string[], labels: Record<string, unknown> }
 */
adminUtterances.post('/utterances/labels', async (c) => {
  const { utteranceIds, labels } = getBody<{
    utteranceIds: string[]
    labels: Record<string, unknown>
  }>(c)

  if (!Array.isArray(utteranceIds) || utteranceIds.length === 0) {
    return c.json({ error: 'utteranceIds must be a non-empty array' }, 400)
  }
  if (!labels || typeof labels !== 'object') {
    return c.json({ error: 'labels must be an object' }, 400)
  }

  const { labelSource, ...labelFields } = labels as { labelSource?: string } & Record<string, unknown>

  try {
    const { error } = await supabaseAdmin
      .from('utterances')
      .update({
        labels: labelFields,
        label_source: labelSource ?? 'admin',
        updated_at: new Date().toISOString(),
      })
      .in('id', utteranceIds)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ data: { updated: utteranceIds.length } })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error'
    return c.json({ error: message }, 500)
  }
})

/**
 * POST /admin/utterances/:id/quality-review
 * 납품 품질 검수 판정 저장 (저품질 검수 큐 액션 버튼에서 호출).
 *
 * ⚠️ 일반 review_status 와 직교 — 이 엔드포인트는 quality_review_status 만 변경하며
 *    review_status / exclude_reason 은 절대 건드리지 않는다.
 *
 * Body: { status, reason?, note? }
 *   status: 'pending' | 'approved_exception' | 'excluded_low_quality'
 *         | 'needs_retranscription' | 'needs_pii_masking' | 'needs_transcript_edit'
 *   reason (excluded_low_quality 시 필수): 'noisy' | 'too_short' | 'clipped'
 *         | 'unintelligible' | 'wrong_transcript' | 'pii_unresolved' | 'duplicate' | 'other'
 *   note: 선택 자유 메모
 */
const QUALITY_REVIEW_STATUSES = [
  'pending',
  'approved_exception',
  'excluded_low_quality',
  'needs_retranscription',
  'needs_pii_masking',
  'needs_transcript_edit',
] as const
type QualityReviewStatus = (typeof QUALITY_REVIEW_STATUSES)[number]

const QUALITY_EXCLUSION_REASONS = [
  'noisy',
  'too_short',
  'clipped',
  'unintelligible',
  'wrong_transcript',
  'pii_unresolved',
  'duplicate',
  'other',
] as const
type QualityExclusionReason = (typeof QUALITY_EXCLUSION_REASONS)[number]

adminUtterances.post('/utterances/:id/quality-review', async (c) => {
  const utteranceId = c.req.param('id')
  const userId = c.get('userId') as string
  const { status, reason, note } = getBody<{
    status: QualityReviewStatus
    reason?: QualityExclusionReason | null
    note?: string | null
  }>(c)

  if (!QUALITY_REVIEW_STATUSES.includes(status)) {
    return c.json({ error: `status must be one of: ${QUALITY_REVIEW_STATUSES.join(', ')}` }, 400)
  }

  if (reason != null && !QUALITY_EXCLUSION_REASONS.includes(reason)) {
    return c.json({ error: `reason must be one of: ${QUALITY_EXCLUSION_REASONS.join(', ')}` }, 400)
  }

  // 제외 판정은 사유 필수 (감사 추적 + 리포트 분류)
  if (status === 'excluded_low_quality' && reason == null) {
    return c.json({ error: 'reason is required when status is excluded_low_quality' }, 400)
  }

  // pending 으로 되돌릴 때는 사유/메모 초기화
  const resetToPending = status === 'pending'

  try {
    const now = new Date().toISOString()
    const { error } = await supabaseAdmin
      .from('utterances')
      .update({
        quality_review_status: status,
        quality_exclusion_reason: resetToPending ? null : (reason ?? null),
        quality_review_note: resetToPending ? null : (note ?? null),
        quality_reviewed_at: now,
        quality_reviewed_by: userId,
        updated_at: now,
      })
      .eq('id', utteranceId)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ data: { ok: true, status, reason: resetToPending ? null : (reason ?? null) } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /admin/quality-review/report
 * 저품질 검수 큐 리포트 집계 (발화 수 기준).
 *
 * Query:
 *   session_id — 특정 세션 범위 (해당 세션 전체 발화)
 *   filter=quality_c — 전역 C등급(+파생 C) 큐 범위
 *   (둘 중 하나 필수)
 *
 * 설계 §6.1. C등급 판정은 admin-reviews 의 C 필터 조건과 동일:
 *   quality_grade='C' OR (quality_grade IS NULL AND quality_score < 50)
 */
adminUtterances.get('/quality-review/report', async (c) => {
  const sessionId = c.req.query('session_id') ?? null
  const filter = c.req.query('filter') ?? null

  if (!sessionId && filter !== 'quality_c') {
    return c.json({ error: 'session_id or filter=quality_c is required' }, 400)
  }

  const cols = 'quality_grade, quality_score, quality_review_status, quality_exclusion_reason'

  try {
    let query = supabaseAdmin.from('utterances').select(cols)
    if (sessionId) {
      query = query.eq('session_id', sessionId).limit(50000)
    } else {
      // 전역 C 큐: admin-reviews.ts 의 C 필터 조건과 동일
      query = query.or('quality_grade.eq.C,and(quality_grade.is.null,quality_score.lt.50)').limit(5000)
    }

    const { data, error } = await query
    if (error) return c.json({ error: error.message }, 500)

    const rows = (data ?? []) as Array<Record<string, unknown>>

    const isCGrade = (r: Record<string, unknown>): boolean => {
      const g = typeof r.quality_grade === 'string' ? r.quality_grade.trim().toUpperCase() : null
      if (g === 'C') return true
      const score = typeof r.quality_score === 'number' ? r.quality_score : null
      return g === null && score !== null && score < 50
    }

    const statusOf = (r: Record<string, unknown>): string =>
      typeof r.quality_review_status === 'string' ? r.quality_review_status : 'pending'

    const cRows = rows.filter(isCGrade)
    const countStatus = (status: string) => cRows.filter((r) => statusOf(r) === status).length

    let finalIncluded = 0
    for (const r of rows) {
      if (isUtteranceDeliverable(r).included) finalIncluded += 1
    }

    return c.json({
      data: {
        scope: sessionId ? 'session' : 'quality_c',
        sessionId,
        scopeTotalUtterances: rows.length,
        // C등급 처리 현황 (발화 수)
        totalCUtterances: cRows.length,
        excludedCount: countStatus('excluded_low_quality'),
        approvedExceptionCount: countStatus('approved_exception'),
        transcriptEditCount: countStatus('needs_transcript_edit'),
        piiMaskingCount: countStatus('needs_pii_masking'),
        retranscriptionCount: countStatus('needs_retranscription'),
        pendingCount: countStatus('pending'),
        // 최종 납품 판정 (범위 전체 기준)
        finalIncludedUtterances: finalIncluded,
        finalExcludedUtterances: rows.length - finalIncluded,
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default adminUtterances
