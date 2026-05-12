// ── Admin Downloads (STAGE 8) ──────────────────────────────────────────
// 풀패키지 zip 다운로드 — 검수용. 한 세션의 raw audio + utterance WAV +
// transcript JSON + metadata JSON 을 zip 으로 즉석 스트리밍.
//
// 라우트: GET /api/admin/sessions/:id/download-package
//   :id 는 admin UI 가 보낸 encryptId 값 (sessionFromRow 가 encryptId 적용함).
//
// 구조:
//   session_{seq}/
//     metadata.json                 (세션 row + display_title + utterance 카운트)
//     transcript.json               (utterances 의 transcript_text 합본, 시간순)
//     raw_audio.{ext}               (sessions.raw_audio_url → S3 객체)
//     utterances/
//       001_{speaker}.wav           (utterances.storage_path → S3 객체)
//
// 누락 파일 (storage_path 없음 / 404) 은 manifest 에 표시하고 스킵.

import { Hono } from 'hono'
import { Readable } from 'node:stream'
import archiver from 'archiver'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware } from '../lib/middleware.js'
import { decryptId } from '../lib/crypto.js'
import { s3Client, S3_AUDIO_BUCKET } from '../lib/s3.js'
import { formatDisplayTitle } from '../lib/displayTitle.js'

const adminDownloads = new Hono()

adminDownloads.use('/*', authMiddleware)
adminDownloads.use('/*', adminMiddleware)

async function downloadStream(bucket: string, key: string): Promise<Readable | null> {
  try {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    if (!res.Body) return null
    return res.Body as Readable
  } catch (err) {
    console.warn('[admin-downloads] s3 fetch failed', { bucket, key, err: (err as Error)?.message })
    return null
  }
}

function extOf(path: string): string {
  const m = path.split('/').pop() ?? ''
  const dot = m.lastIndexOf('.')
  return dot >= 0 ? m.slice(dot + 1).toLowerCase() : 'bin'
}

function safeNum(n: number, pad = 3): string {
  return String(n).padStart(pad, '0')
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

adminDownloads.get('/sessions/:id/download-package', async (c) => {
  const idParam = c.req.param('id')
  let sessionId: string
  if (UUID_RE.test(idParam)) {
    sessionId = idParam
  } else {
    try {
      sessionId = decryptId(idParam)
    } catch {
      return c.json({ error: 'invalid session id' }, 400)
    }
  }

  const { data: session, error: sessErr } = await supabaseAdmin
    .from('sessions')
    .select('id, session_seq, date, duration, raw_audio_url, consent_status, review_status, user_id')
    .eq('id', sessionId)
    .maybeSingle()

  if (sessErr) return c.json({ error: sessErr.message }, 500)
  if (!session) return c.json({ error: 'session not found' }, 404)

  const { data: utterances, error: uttErr } = await supabaseAdmin
    .from('utterances')
    .select('id, sequence_order, speaker_id, start_sec, end_sec, duration_sec, storage_path, transcript_text, snr_db, quality_score, quality_grade, review_status, exclude_reason')
    .eq('session_id', sessionId)
    .order('sequence_order', { ascending: true })

  if (uttErr) return c.json({ error: uttErr.message }, 500)

  const seq = session.session_seq as number | null
  const displayTitle = formatDisplayTitle(seq, session.date as string | null, session.duration as number | null)
  const folderName = `session_${seq != null ? safeNum(seq, 6) : 'unknown'}`
  const zipFilename = `${folderName}.zip`

  const archive = archiver('zip', { zlib: { level: 6 } })
  const passthrough = new Readable({ read() {} })
  const manifest = {
    schemaVersion: 'admin-download-1.0',
    sessionId,
    displayTitle,
    sessionSeq: seq,
    date: session.date,
    durationSec: session.duration,
    consentStatus: session.consent_status,
    reviewStatus: session.review_status,
    rawAudio: { present: false, path: session.raw_audio_url, ext: null as string | null, error: null as string | null },
    utterances: { total: (utterances ?? []).length, included: 0, missing: [] as Array<{ id: string; reason: string }> },
    generatedAt: new Date().toISOString(),
  }

  archive.on('data', (chunk) => passthrough.push(chunk))
  archive.on('end', () => passthrough.push(null))
  archive.on('error', (err) => {
    console.error('[admin-downloads] archive error', err)
    passthrough.destroy(err)
  })

  // 비동기로 파일 append → 마지막에 manifest finalize
  ;(async () => {
    try {
      // 1. raw audio
      if (session.raw_audio_url) {
        const ext = extOf(session.raw_audio_url as string)
        manifest.rawAudio.ext = ext
        const stream = await downloadStream(S3_AUDIO_BUCKET, session.raw_audio_url as string)
        if (stream) {
          archive.append(stream, { name: `${folderName}/raw_audio.${ext}` })
          manifest.rawAudio.present = true
        } else {
          manifest.rawAudio.error = 'S3 object missing or fetch failed'
        }
      } else {
        manifest.rawAudio.error = 'raw_audio_url is null'
      }

      // 2. utterance WAV (직렬 다운로드 — admin 1회성 검수)
      const utt = utterances ?? []
      for (const u of utt) {
        const path = u.storage_path as string | null
        if (!path) {
          manifest.utterances.missing.push({ id: u.id as string, reason: 'storage_path null' })
          continue
        }
        const stream = await downloadStream(S3_AUDIO_BUCKET, path)
        if (!stream) {
          manifest.utterances.missing.push({ id: u.id as string, reason: 'S3 fetch failed' })
          continue
        }
        const speaker = (u.speaker_id as string | null) ?? 'S00'
        const seqNo = safeNum((u.sequence_order as number | null) ?? 0, 3)
        archive.append(stream, { name: `${folderName}/utterances/${seqNo}_${speaker}.wav` })
        manifest.utterances.included += 1
      }

      // 3. transcript.json
      const transcriptPayload = {
        sessionId,
        displayTitle,
        utterances: utt.map((u) => ({
          sequence: u.sequence_order,
          speakerId: u.speaker_id,
          startSec: u.start_sec,
          endSec: u.end_sec,
          durationSec: u.duration_sec,
          text: u.transcript_text,
          snrDb: u.snr_db,
          qualityScore: u.quality_score,
          qualityGrade: u.quality_grade,
          reviewStatus: u.review_status,
          excludeReason: u.exclude_reason,
        })),
      }
      archive.append(Buffer.from(JSON.stringify(transcriptPayload, null, 2)), {
        name: `${folderName}/transcript.json`,
      })

      // 4. metadata.json (마지막 — manifest 최종 상태 반영)
      archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), {
        name: `${folderName}/metadata.json`,
      })

      await archive.finalize()
    } catch (err) {
      console.error('[admin-downloads] build error', err)
      archive.abort()
      passthrough.destroy(err as Error)
    }
  })()

  const webStream = Readable.toWeb(passthrough) as ReadableStream<Uint8Array>
  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipFilename}"`,
      'Cache-Control': 'no-store',
    },
  })
})

export default adminDownloads
