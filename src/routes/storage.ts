// ── Storage API Routes ─────────────────────────────────────────────────
// S3 호환 스토리지 (iwinv) 업로드/삭제 로직

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'
import { decryptData } from '../lib/crypto.js'
import {
  uploadObject,
  deleteObjects,
  listObjects,
  getSignedUrl,
  S3_AUDIO_BUCKET,
  S3_META_BUCKET,
} from '../lib/s3.js'

const storage = new Hono()

// 모든 라우트에 인증 필수
storage.use('/*', authMiddleware)

/**
 * POST /storage/audio
 * 정제된 오디오 업로드
 * Body: { sessionId: string, wavData: string (base64) }
 */
storage.post('/audio', async (c) => {
  const userId = c.get('userId') as string
  const { sessionId, wavData } = getBody<{ sessionId: string; wavData: string }>(c)

  if (!sessionId || !wavData) {
    return c.json({ error: 'Missing sessionId or wavData' }, 400)
  }

  const path = `${userId}/${sessionId}/${sessionId}.wav`

  try {
    // base64 디코딩
    const binaryString = atob(wavData)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }

    await uploadObject(S3_AUDIO_BUCKET, path, bytes, 'audio/wav')

    return c.json({ path })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})


/**
 * POST /storage/audio/chunk
 * WAV 청크 단위 업로드 — multipart/form-data
 * - wavFile: WAV binary (Blob)
 * - meta: AES-256-GCM 암호화된 JSON { sessionId, chunkIndex, startSec, endSec, durationSec, fileSizeBytes }
 * 저장 경로: {userId}/{sessionId}/{sessionId}-001.wav
 */
storage.post('/audio/chunk', async (c) => {
  const userId = c.get('userId') as string

  try {
    const form = await c.req.formData()
    const wavFile = form.get('wavFile') as File | null
    const metaRaw = form.get('meta') as string | null

    if (!wavFile || !metaRaw) {
      return c.json({ error: 'Missing wavFile or meta' }, 400)
    }

    const meta = decryptData(metaRaw) as {
      sessionId: string
      chunkIndex: number
      startSec: number
      endSec: number
      durationSec: number
      fileSizeBytes: number
      text?: string
    }

    const { sessionId, chunkIndex, startSec, endSec, durationSec, fileSizeBytes, text } = meta

    if (!sessionId || !chunkIndex) {
      return c.json({ error: 'Missing required meta fields' }, 400)
    }

    const paddedIndex = String(chunkIndex).padStart(3, '0')
    const storagePath = `${userId}/${sessionId}/${sessionId}-${paddedIndex}.wav`

    // File → Uint8Array (base64 변환 없음)
    const bytes = new Uint8Array(await wavFile.arrayBuffer())

    // S3 업로드
    await uploadObject(S3_AUDIO_BUCKET, storagePath, bytes, 'audio/wav')

    // session_chunks INSERT (재시도 시 upsert)
    const { data: chunkRow, error: dbError } = await supabaseAdmin
      .from('session_chunks')
      .upsert(
        {
          session_id:      sessionId,
          user_id:         userId,
          chunk_index:     chunkIndex,
          storage_path:    storagePath,
          start_sec:       startSec,
          end_sec:         endSec,
          duration_sec:    durationSec,
          file_size_bytes: fileSizeBytes ?? bytes.byteLength,
          sample_rate:     16000,
          upload_status:   'uploaded',
          transcript_text: text || null,
          updated_at:      new Date().toISOString(),
        },
        { onConflict: 'session_id,chunk_index' },
      )
      .select('id')
      .single()

    if (dbError) {
      return c.json({ error: dbError.message }, 500)
    }

    return c.json({ path: storagePath, chunkId: chunkRow.id })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /storage/audio/chunks/:sessionId
 * 세션의 청크 목록 조회
 */
storage.get('/audio/chunks/:sessionId', async (c) => {
  const userId = c.get('userId') as string
  const { sessionId } = c.req.param()

  try {
    const { data, error } = await supabaseAdmin
      .from('session_chunks')
      .select('id, chunk_index, storage_path, start_sec, end_sec, duration_sec, upload_status')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .order('chunk_index', { ascending: true })

    if (error) return c.json({ error: error.message }, 500)

    return c.json({ chunks: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /storage/audio/signed-url
 * 비공개 버킷 오디오 재생용 signed URL 발급
 * Body: { storagePath: string, expiresIn?: number }
 */
storage.post('/audio/signed-url', async (c) => {
  const { storagePath, expiresIn = 3600 } = getBody<{ storagePath: string; expiresIn?: number }>(c)

  if (!storagePath) {
    return c.json({ error: 'Missing storagePath' }, 400)
  }

  try {
    const signedUrl = await getSignedUrl(S3_AUDIO_BUCKET, storagePath, expiresIn)

    return c.json({ signedUrl })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /storage/session-chunks
 * 논리 청크 메타 등록 (WAV 없음, v3 logical chunk)
 * Body (암호화): { sessionId, chunkIndex, chunkType, utteranceCount, totalUtteranceDuration, startSec, endSec }
 */
storage.post('/session-chunks', async (c) => {
  const userId = c.get('userId') as string

  try {
    const {
      sessionId,
      chunkIndex,
      chunkType,
      utteranceCount,
      totalUtteranceDuration,
      startSec,
      endSec,
    } = getBody<{
      sessionId: string
      chunkIndex: number
      chunkType: string
      utteranceCount: number
      totalUtteranceDuration: number
      startSec: number
      endSec: number
    }>(c)

    if (!sessionId || chunkIndex === undefined || chunkIndex === null) {
      return c.json({ error: 'Missing sessionId or chunkIndex' }, 400)
    }

    // chunkType 허용값 검증
    const allowedChunkTypes = ['wav', 'logical']
    if (chunkType && !allowedChunkTypes.includes(chunkType)) {
      return c.json({ error: 'Invalid chunkType: must be wav or logical' }, 400)
    }

    // 세션 소유권 검증
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .single()
    if (!session) return c.json({ error: 'Session not found or access denied' }, 403)

    const durationSec = endSec - startSec

    const { data: chunkRow, error: dbError } = await supabaseAdmin
      .from('session_chunks')
      .upsert(
        {
          session_id:               sessionId,
          user_id:                  userId,
          chunk_index:              chunkIndex,
          chunk_type:               chunkType || 'logical',
          utterance_count:          utteranceCount ?? 0,
          total_utterance_duration: totalUtteranceDuration ?? null,
          start_sec:                startSec,
          end_sec:                  endSec,
          duration_sec:             durationSec,
          storage_path:             null,
          sample_rate:              16000,
          upload_status:            'uploaded',
          updated_at:               new Date().toISOString(),
        },
        { onConflict: 'session_id,chunk_index' },
      )
      .select('id')
      .single()

    if (dbError) {
      return c.json({ error: dbError.message }, 500)
    }

    return c.json({ chunkId: chunkRow.id })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /storage/audio/utterance
 * 발화 WAV + 메타 업로드 — multipart/form-data
 * - wavFile: WAV binary (Blob)
 * - meta: AES-256-GCM 암호화된 JSON (utterance 메타데이터)
 * 저장 경로: utterances/{sessionId}/{utteranceId}.wav
 */
storage.post('/audio/utterance', async (c) => {
  const userId = c.get('userId') as string

  try {
    const form = await c.req.formData()
    const wavFile = form.get('wavFile') as File | null
    const metaRaw = form.get('meta') as string | null

    if (!wavFile || !metaRaw) {
      return c.json({ error: 'Missing wavFile or meta' }, 400)
    }

    const meta = decryptData(metaRaw) as {
      sessionId: string
      utteranceId: string
      chunkId: number
      sequenceOrder: number
      sequenceInChunk: number
      speakerId: string
      isUser: boolean
      startSec: number
      endSec: number
      durationSec: number
      paddedStartSec?: number
      paddedEndSec?: number
      paddedDurationSec?: number
      transcriptText?: string
      transcriptWords?: unknown
      snrDb?: number
      speechRatio?: number
      clippingRatio?: number
      beepMaskRatio?: number
      qualityScore?: number
      qualityGrade?: string
      volumeLufs?: number
      segmentedBy?: string
      clientVersion?: string
      labels?: Record<string, string>
      dialogAct?: string
      labelSource?: string
      labelConfidence?: number
    }

    const { sessionId, utteranceId } = meta

    if (!sessionId || !utteranceId) {
      return c.json({ error: 'Missing required meta fields' }, 400)
    }

    // WAV 파일 크기 제한 (10MB)
    const MAX_WAV_SIZE = 10 * 1024 * 1024
    if (wavFile.size > MAX_WAV_SIZE) {
      return c.json({ error: 'WAV file too large: max 10MB' }, 413)
    }

    // 세션 소유권 검증
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .single()
    if (!session) return c.json({ error: 'Session not found or access denied' }, 403)

    const storagePath = `utterances/${sessionId}/${utteranceId}.wav`

    // File → Uint8Array
    const bytes = new Uint8Array(await wavFile.arrayBuffer())

    // S3 업로드 먼저
    await uploadObject(S3_AUDIO_BUCKET, storagePath, bytes, 'audio/wav')

    // utterances UPSERT
    const { error: dbError } = await supabaseAdmin
      .from('utterances')
      .upsert(
        {
          id:                  utteranceId,
          session_id:          sessionId,
          chunk_id:            meta.chunkId ?? null,
          user_id:             userId,
          sequence_in_chunk:   meta.sequenceInChunk,
          sequence_order:      meta.sequenceOrder,
          speaker_id:          meta.speakerId,
          is_user:             meta.isUser,
          start_sec:           meta.startSec,
          end_sec:             meta.endSec,
          duration_sec:        meta.durationSec,
          padded_start_sec:    meta.paddedStartSec ?? null,
          padded_end_sec:      meta.paddedEndSec ?? null,
          padded_duration_sec: meta.paddedDurationSec ?? null,
          storage_path:        storagePath,
          file_size_bytes:     bytes.byteLength,
          upload_status:       'uploaded',
          transcript_text:     meta.transcriptText ?? null,
          transcript_words:    meta.transcriptWords ?? null,
          snr_db:              meta.snrDb ?? null,
          speech_ratio:        meta.speechRatio ?? null,
          clipping_ratio:      meta.clippingRatio ?? null,
          beep_mask_ratio:     meta.beepMaskRatio ?? null,
          quality_score:       meta.qualityScore ?? null,
          quality_grade:       meta.qualityGrade ?? null,
          volume_lufs:         meta.volumeLufs ?? null,
          labels:              meta.labels ?? null,
          dialog_act:          meta.dialogAct ?? null,
          label_source:        meta.labelSource ?? null,
          label_confidence:    meta.labelConfidence ?? null,
          segmented_by:        meta.segmentedBy ?? 'client',
          client_version:      meta.clientVersion ?? null,
          updated_at:          new Date().toISOString(),
        },
        { onConflict: 'session_id,sequence_order' },
      )

    if (dbError) {
      // DB 실패 시 S3 정리
      try {
        await deleteObjects(S3_AUDIO_BUCKET, [storagePath])
      } catch (_) {
        // S3 삭제 실패는 무시 (orphan 파일은 추후 정리)
      }
      return c.json({ error: dbError.message }, 500)
    }

    return c.json({ storagePath, utteranceId })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /storage/raw-audio
 * BM v10 — Raw audio 업로드 (GPU 서버 처리 큐 진입)
 *
 * 흐름:
 *   App: 동의 양측 완료 → raw audio (m4a/wav) 를 이 엔드포인트로 업로드
 *   API: iwinv S3 'raw-audio/{userId}/{sessionId}.{ext}' 에 저장
 *        sessions.raw_audio_url + size + uploaded_at 업데이트
 *   Worker: raw_audio_url IS NOT NULL AND gpu_upload_status='pending' 폴링
 *
 * Body (multipart/form-data):
 *   - audioFile: 음성 binary (Blob, m4a/wav/mp3)
 *   - meta:      AES-256-GCM 암호화된 JSON { sessionId, ext }
 *
 * 응답: { storagePath, sizeBytes }
 *
 * 제약: 500MB 한도 (voice_api 와 동일)
 */
storage.post('/raw-audio', async (c) => {
  const userId = c.get('userId') as string

  try {
    const form = await c.req.formData()
    const audioFile = form.get('audioFile') as File | null
    const metaRaw = form.get('meta') as string | null

    if (!audioFile || !metaRaw) {
      return c.json({ error: 'Missing audioFile or meta' }, 400)
    }

    const meta = decryptData(metaRaw) as {
      sessionId: string
      ext: string
    }

    const { sessionId, ext } = meta
    if (!sessionId || !ext) {
      return c.json({ error: 'Missing sessionId or ext in meta' }, 400)
    }

    // 확장자 화이트리스트 — voice_api 가 처리 가능한 포맷
    const ALLOWED_EXTS = ['m4a', 'wav', 'mp3', 'ogg', 'flac', 'webm', 'mp4']
    const normalizedExt = ext.toLowerCase().replace(/^\./, '')
    if (!ALLOWED_EXTS.includes(normalizedExt)) {
      return c.json(
        { error: `Unsupported ext: ${normalizedExt}. Allowed: ${ALLOWED_EXTS.join(', ')}` },
        400,
      )
    }

    // 파일 크기 한도 500MB (voice_api MAX_UPLOAD_SIZE 와 동일)
    const MAX_RAW_SIZE = 500 * 1024 * 1024
    if (audioFile.size > MAX_RAW_SIZE) {
      return c.json({ error: 'Raw audio file too large: max 500MB' }, 413)
    }
    if (audioFile.size === 0) {
      return c.json({ error: 'Empty audio file' }, 400)
    }

    // 세션 소유권 검증
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id, raw_audio_url')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .single()
    if (!session) {
      return c.json({ error: 'Session not found or access denied' }, 403)
    }

    // 이미 업로드된 raw audio 가 있으면 거부 (중복 업로드 방지)
    if (session.raw_audio_url) {
      return c.json(
        { error: 'Raw audio already uploaded for this session', existing: session.raw_audio_url },
        409,
      )
    }

    const storagePath = `raw-audio/${userId}/${sessionId}.${normalizedExt}`
    const contentType =
      normalizedExt === 'm4a' || normalizedExt === 'mp4'
        ? 'audio/mp4'
        : normalizedExt === 'wav'
          ? 'audio/wav'
          : normalizedExt === 'mp3'
            ? 'audio/mpeg'
            : 'application/octet-stream'

    // S3 업로드
    const bytes = new Uint8Array(await audioFile.arrayBuffer())
    await uploadObject(S3_AUDIO_BUCKET, storagePath, bytes, contentType)

    // sessions UPDATE — raw_audio_* 채우기. gpu_upload_status 는 'pending' 그대로.
    // 워커 폴링 조건: raw_audio_url IS NOT NULL AND gpu_upload_status='pending'
    const { error: dbError } = await supabaseAdmin
      .from('sessions')
      .update({
        raw_audio_url: storagePath,
        raw_audio_size: bytes.byteLength,
        raw_audio_uploaded_at: new Date().toISOString(),
        // gpu_upload_status='pending' 기본값 — 변경하지 않음
      })
      .eq('id', sessionId)
      .eq('user_id', userId)

    if (dbError) {
      // DB 실패 시 S3 정리 (orphan 방지)
      try {
        await deleteObjects(S3_AUDIO_BUCKET, [storagePath])
      } catch (_) {
        // S3 정리 실패는 무시 — 30일 lifecycle 이 청소
      }
      return c.json({ error: dbError.message }, 500)
    }

    // BM v10 — DB commit 성공 직후 워커 즉시 깨움 (30초 폴링 latency 제거).
    // import dynamic 으로 순환 import 회피. resolve 만 호출, 처리는 워커가 비동기 진행.
    void import('../services/gpu-worker.js').then((m) =>
      m.triggerWorker(`raw-audio uploaded sessionId=${sessionId}`),
    ).catch(() => {/* trigger 실패는 polling fallback 에 의지 */})

    return c.json({ storagePath, sizeBytes: bytes.byteLength })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/**
 * DELETE /storage/user
 * 사용자 파일 전체 삭제 (데이터 철회)
 */
storage.delete('/user', async (c) => {
  const userId = c.get('userId') as string

  try {
    // 오디오 파일 삭제
    const audioFiles = await listObjects(S3_AUDIO_BUCKET, `${userId}/`)
    if (audioFiles.length > 0) {
      await deleteObjects(S3_AUDIO_BUCKET, audioFiles.map((f) => f.key))
    }

    // 메타 파일 삭제
    const metaFiles = await listObjects(S3_META_BUCKET, `${userId}/`)
    if (metaFiles.length > 0) {
      await deleteObjects(S3_META_BUCKET, metaFiles.map((f) => f.key))
    }

    return c.json({ success: true, deletedFiles: audioFiles.length + metaFiles.length })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default storage
