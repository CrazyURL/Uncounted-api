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
 * POST /storage/meta
 * 메타 JSONL 업로드
 * Body: { batchId: string, content: string (JSONL text) }
 */
storage.post('/meta', async (c) => {
  const userId = c.get('userId') as string
  const { batchId, content } = getBody<{ batchId: string; content: string }>(c)

  if (!batchId || !content) {
    return c.json({ error: 'Missing batchId or content' }, 400)
  }

  const path = `${userId}/${batchId}.jsonl`

  try {
    await uploadObject(S3_META_BUCKET, path, content, 'application/x-ndjson')

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
