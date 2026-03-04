// ── Storage API Routes ─────────────────────────────────────────────────
// Supabase Storage 업로드/삭제 로직을 백엔드 API로 분리

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase'
import { authMiddleware, getBody } from '../lib/middleware'

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
