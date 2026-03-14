// ── Storage API Routes ─────────────────────────────────────────────────
// Supabase Storage 업로드/삭제 로직을 백엔드 API로 분리

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, getBody } from '../lib/middleware.js'
import { decryptData } from '../lib/crypto.js'

const storage = new Hono()

// 모든 라우트에 인증 필수
storage.use('/*', authMiddleware)

const AUDIO_BUCKET = 'sanitized-audio'
const META_BUCKET = 'meta-jsonl'

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

  const path = `${userId}/${sessionId}.wav`

  try {
    // base64 디코딩
    const binaryString = atob(wavData)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }

    const { error } = await supabaseAdmin.storage
      .from(AUDIO_BUCKET)
      .upload(path, bytes, {
        contentType: 'audio/wav',
        upsert: true,
      })

    if (error) {
      return c.json({ error: error.message }, 500)
    }

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
    const { error } = await supabaseAdmin.storage
      .from(META_BUCKET)
      .upload(path, content, {
        contentType: 'application/x-ndjson',
        upsert: true,
      })

    if (error) {
      return c.json({ error: error.message }, 500)
    }

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

    // Supabase Storage 업로드
    const { error: uploadError } = await supabaseAdmin.storage
      .from(AUDIO_BUCKET)
      .upload(storagePath, bytes, { contentType: 'audio/wav', upsert: true })

    if (uploadError) {
      return c.json({ error: uploadError.message }, 500)
    }

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
    const { data, error } = await supabaseAdmin.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(storagePath, expiresIn)

    if (error || !data?.signedUrl) {
      return c.json({ error: error?.message ?? 'Failed to create signed URL' }, 500)
    }

    return c.json({ signedUrl: data.signedUrl })
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
    const { data: audioFiles } = await supabaseAdmin.storage
      .from(AUDIO_BUCKET)
      .list(userId)

    if (audioFiles && audioFiles.length > 0) {
      const audioPaths = audioFiles.map((f) => `${userId}/${f.name}`)
      await supabaseAdmin.storage.from(AUDIO_BUCKET).remove(audioPaths)
    }

    // 메타 파일 삭제
    const { data: metaFiles } = await supabaseAdmin.storage
      .from(META_BUCKET)
      .list(userId)

    if (metaFiles && metaFiles.length > 0) {
      const metaPaths = metaFiles.map((f) => `${userId}/${f.name}`)
      await supabaseAdmin.storage.from(META_BUCKET).remove(metaPaths)
    }

    return c.json({ success: true, deletedFiles: (audioFiles?.length ?? 0) + (metaFiles?.length ?? 0) })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default storage
