// ── Export Builder ────────────────────────────────────────────────────
// 3-Layer Export Architecture
//
// Layer 1: buildDeliveryPackageZip(packageId) → { sizeBytes }
//   - 배달 패키지 ZIP, 임베디드 WAV, packaging-worker에서 호출
//
// Layer 2: buildSingleSessionZip(sessionId) → storagePath
//   - 단건 세션 on-demand export (reference_only, signed URL)
//
// Layer 3: buildBatchZip(sessionIds) → storagePath
//   - 배치 세션 async export (reference_only, signed URL)
//
// SECURITY: pii_intervals.original 필드는 어떤 레이어도 절대 포함하지 않음
// ─────────────────────────────────────────────────────────────────────

import archiver, { Archiver } from 'archiver'
import { PassThrough } from 'stream'
import { Upload } from '@aws-sdk/lib-storage'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'
import { supabaseAdmin, fetchAllPaginated } from '../lib/supabase.js'
import { s3Client, S3_AUDIO_BUCKET, getSignedUrls } from '../lib/s3.js'

const AUDIO_DOWNLOAD_CONCURRENCY = 4
const SIGNED_URL_EXPIRES = 86_400 // 24h
const UPLOAD_PART_SIZE = 8 * 1024 * 1024
const UPLOAD_QUEUE_SIZE = 4

// ── DB Row Types ───────────────────────────────────────────────────────

interface PiiInterval {
  startSec: number
  endSec: number
  maskType: string
  piiType: string
  original?: string // SECURITY: never forward this field
}

interface SafePiiInterval {
  startSec: number
  endSec: number
  maskType: string
  piiType: string
}

interface UtteranceRow {
  id: string
  session_id: string
  sequence_order: number
  speaker_id: string | null
  session_speaker_id: string | null
  segment_id: string | null
  start_ms: number
  end_ms: number
  start_sec: number
  end_sec: number
  padded_start_sec: number | null
  padded_end_sec: number | null
  duration_seconds: number
  duration_sec: number | null
  transcript_text: string | null
  transcript_words: unknown | null
  storage_path: string | null
  emotion: string | null
  emotion_confidence: number | null
  dialog_act: string | null
  dialog_act_confidence: number | null
  label_source: string | null
  auto_label_model_version: string | null
  snr_db: number | null
  speech_ratio: number | null
  clipping_ratio: number | null
  quality_score: number | null
  quality_grade: string | null
  pii_intervals: PiiInterval[] | null
}

interface SpeakerRow {
  id: string
  speaker_id: string
  speaker_role: string | null
  speaker_gender: string | null
  speaker_voice_age_range: string | null
  speaker_speech_age_range: string | null
}

interface SessionRow {
  id: string
  duration: number
  stt_status: string
  diarize_status: string | null
  quality_grade_min: string | null
  quality_score_avg: number | null
  snr_db_avg: number | null
  speech_ratio_avg: number | null
  pii_flag: boolean
  pii_count: number
  session_speakers: SpeakerRow[]
}

// ── PII Safety ─────────────────────────────────────────────────────────

// SECURITY: original 필드를 항상 제거. destructuring으로 명시적 제외.
function safePiiIntervals(intervals: PiiInterval[] | null): SafePiiInterval[] | null {
  if (!intervals) return null
  return intervals.map(({ startSec, endSec, maskType, piiType }) => ({
    startSec, endSec, maskType, piiType,
  }))
}

// ── S3 / ZIP Helpers ───────────────────────────────────────────────────

async function downloadWav(storagePath: string): Promise<Buffer> {
  const cmd = new GetObjectCommand({ Bucket: S3_AUDIO_BUCKET, Key: storagePath })
  const response = await s3Client.send(cmd)
  const chunks: Buffer[] = []
  for await (const chunk of response.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

// WAV files use STORE (no compression) — lossless binary, compression saves nothing
async function appendWavBatch(archive: Archiver, utterances: UtteranceRow[], dirName: string): Promise<void> {
  const withPath = utterances.filter(u => u.storage_path)
  for (let i = 0; i < withPath.length; i += AUDIO_DOWNLOAD_CONCURRENCY) {
    const batch = withPath.slice(i, i + AUDIO_DOWNLOAD_CONCURRENCY)
    const buffers = await Promise.all(batch.map(async utt => ({
      id: utt.id,
      buf: await downloadWav(utt.storage_path!),
    })))
    for (const { id, buf } of buffers) {
      archive.append(buf, { name: `${dirName}/audio/${id}.wav`, store: true })
    }
  }
}

// Deadlock-free ZIP streaming to S3.
// upload.done()을 await 없이 먼저 호출해야 함 — archive가 append를 시작하기 전에
// await하면 upload 완료까지 block되어 deadlock 발생.
async function streamZipToS3(
  storagePath: string,
  populate: (archive: Archiver) => Promise<void>,
): Promise<{ sizeBytes: number }> {
  const archive = archiver('zip', { zlib: { level: 6 } })
  const passthrough = new PassThrough()
  archive.pipe(passthrough)

  let archiveError: Error | null = null
  const upload = new Upload({
    client: s3Client,
    params: { Bucket: S3_AUDIO_BUCKET, Key: storagePath, Body: passthrough, ContentType: 'application/zip' },
    queueSize: UPLOAD_QUEUE_SIZE,
    partSize: UPLOAD_PART_SIZE,
  })

  archive.on('error', async (err: Error) => {
    archiveError = err
    await upload.abort()
  })

  const uploadPromise = upload.done() // CRITICAL: no await

  try {
    await populate(archive)
    await archive.finalize()
  } catch (err) {
    uploadPromise.catch(() => {})
    await upload.abort().catch(() => {})
    throw err
  }

  if (archiveError) {
    uploadPromise.catch(() => {})
    throw archiveError
  }

  await uploadPromise
  return { sizeBytes: archive.pointer() }
}

// ── DB Query Helpers ───────────────────────────────────────────────────

async function fetchUtterances(sessionIds: string[]): Promise<UtteranceRow[]> {
  return fetchAllPaginated<UtteranceRow>(
    () => supabaseAdmin
      .from('utterances')
      .select(`
        id, session_id, sequence_order,
        speaker_id, session_speaker_id, segment_id,
        start_ms, end_ms, start_sec, end_sec,
        padded_start_sec, padded_end_sec,
        duration_seconds, duration_sec,
        transcript_text, transcript_words,
        storage_path,
        emotion, emotion_confidence,
        dialog_act, dialog_act_confidence,
        label_source, auto_label_model_version,
        snr_db, speech_ratio, clipping_ratio,
        quality_score, quality_grade,
        pii_intervals
      `)
      .in('session_id', sessionIds)
      .order('session_id')
      .order('sequence_order'),
  )
}

async function fetchSessionsWithSpeakers(sessionIds: string[]): Promise<SessionRow[]> {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select(`
      id, duration, stt_status, diarize_status,
      quality_grade_min, quality_score_avg, snr_db_avg, speech_ratio_avg,
      pii_flag, pii_count,
      session_speakers (
        id, speaker_id, speaker_role, speaker_gender,
        speaker_voice_age_range, speaker_speech_age_range
      )
    `)
    .in('id', sessionIds)
  if (error) throw new Error(`[export-builder] sessions query: ${error.message}`)
  return (data ?? []) as SessionRow[]
}

async function fetchTopicSegments(sessionIds: string[]): Promise<unknown[]> {
  const { data, error } = await supabaseAdmin
    .from('session_segments')
    .select('id, session_id, segment_index, topic, start_ms, end_ms')
    .in('session_id', sessionIds)
    .order('session_id')
    .order('segment_index')
  if (error) {
    console.warn('[export-builder] topic segments query failed:', error.message)
    return []
  }
  return data ?? []
}

function buildSpeakerMap(sessions: SessionRow[]): Map<string, SpeakerRow> {
  const map = new Map<string, SpeakerRow>()
  for (const s of sessions) {
    for (const sp of s.session_speakers ?? []) {
      map.set(sp.id, sp)
    }
  }
  return map
}

function groupBySession(utterances: UtteranceRow[]): Map<string, UtteranceRow[]> {
  const map = new Map<string, UtteranceRow[]>()
  for (const utt of utterances) {
    const arr = map.get(utt.session_id) ?? []
    arr.push(utt)
    map.set(utt.session_id, arr)
  }
  return map
}

// ── Content Builders ───────────────────────────────────────────────────

function buildUtterancesJsonl(utterances: UtteranceRow[], speakerMap: Map<string, SpeakerRow>): string {
  return utterances.map(utt => {
    const sp = utt.session_speaker_id ? speakerMap.get(utt.session_speaker_id) : undefined
    return JSON.stringify({
      utterance_id: utt.id,
      session_id: utt.session_id,
      sequence_order: utt.sequence_order,
      speaker_id: utt.speaker_id,
      session_speaker_id: utt.session_speaker_id,
      start_ms: utt.start_ms,
      end_ms: utt.end_ms,
      start_sec: utt.start_sec,
      end_sec: utt.end_sec,
      padded_start_sec: utt.padded_start_sec,
      padded_end_sec: utt.padded_end_sec,
      duration_sec: utt.duration_sec ?? utt.duration_seconds,
      text: utt.transcript_text,
      words: utt.transcript_words,
      speaker: sp ? {
        role: sp.speaker_role,
        gender: sp.speaker_gender,
        voice_age_range: sp.speaker_voice_age_range,
        speech_age_range: sp.speaker_speech_age_range,
      } : null,
      auto_labels: {
        emotion: utt.emotion,
        emotion_confidence: utt.emotion_confidence,
        dialog_act: utt.dialog_act,
        dialog_act_confidence: utt.dialog_act_confidence,
        label_source: utt.label_source,
        model_version: utt.auto_label_model_version,
      },
      quality: {
        snr_db: utt.snr_db,
        speech_ratio: utt.speech_ratio,
        clipping_ratio: utt.clipping_ratio,
        score: utt.quality_score,
        grade: utt.quality_grade,
      },
      pii_intervals: safePiiIntervals(utt.pii_intervals),
    })
  }).join('\n')
}

function buildLabelsJsonl(utterances: UtteranceRow[]): string {
  return utterances.map(utt => JSON.stringify({
    utterance_id: utt.id,
    session_id: utt.session_id,
    emotion: utt.emotion,
    emotion_confidence: utt.emotion_confidence,
    dialog_act: utt.dialog_act,
    dialog_act_confidence: utt.dialog_act_confidence,
    label_source: utt.label_source,
    auto_label_model_version: utt.auto_label_model_version,
    quality_grade: utt.quality_grade,
    quality_score: utt.quality_score,
  })).join('\n')
}

function buildPiiReport(sessionId: string, utterances: UtteranceRow[]): unknown {
  const intervals = utterances.flatMap(utt =>
    (utt.pii_intervals ?? []).map(({ startSec, endSec, maskType, piiType }) => ({
      utterance_id: utt.id, startSec, endSec, maskType, piiType,
      // original intentionally excluded
    }))
  )
  const byType: Record<string, number> = {}
  for (const p of intervals) byType[p.piiType] = (byType[p.piiType] ?? 0) + 1
  return { session_id: sessionId, total_pii_count: intervals.length, by_type: byType, intervals }
}

function buildAudioManifest(
  utterances: UtteranceRow[],
  signedUrlMap: Map<string, string> | null,
  audioMode: 'embedded' | 'reference_only',
): unknown {
  return {
    audio_mode: audioMode,
    utterances: utterances
      .filter(u => u.storage_path)
      .map(u => ({
        utterance_id: u.id,
        session_id: u.session_id,
        sequence_order: u.sequence_order,
        storage_path: u.storage_path,
        signed_url: signedUrlMap ? (signedUrlMap.get(u.storage_path!) ?? null) : null,
      })),
  }
}

function buildQualityReport(session: SessionRow, utterances: UtteranceRow[]): unknown {
  const grades: Record<string, number> = {}
  const emotions: Record<string, number> = {}
  const dialogActs: Record<string, number> = {}
  for (const u of utterances) {
    if (u.quality_grade) grades[u.quality_grade] = (grades[u.quality_grade] ?? 0) + 1
    if (u.emotion) emotions[u.emotion] = (emotions[u.emotion] ?? 0) + 1
    if (u.dialog_act) dialogActs[u.dialog_act] = (dialogActs[u.dialog_act] ?? 0) + 1
  }
  return {
    session_id: session.id,
    quality_grade_min: session.quality_grade_min,
    quality_score_avg: session.quality_score_avg,
    snr_db_avg: session.snr_db_avg,
    speech_ratio_avg: session.speech_ratio_avg,
    grade_distribution: grades,
    emotion_distribution: emotions,
    dialog_act_distribution: dialogActs,
  }
}

// Static schema document versioned with the label set
const LABEL_SCHEMA = {
  version: '1.0',
  fields: {
    emotion: { type: 'string', values: ['neutral', 'joy', 'sadness', 'anger', 'fear', 'disgust', 'surprise'] },
    emotion_confidence: { type: 'number', range: [0, 1] },
    dialog_act: { type: 'string', values: ['inform', 'question', 'directive', 'commissive', 'greeting', 'farewell', 'unknown'] },
    dialog_act_confidence: { type: 'number', range: [0, 1] },
    label_source: { type: 'string', values: ['auto', 'manual'] },
    quality_grade: { type: 'string', values: ['A', 'B', 'C', 'D'] },
    quality_score: { type: 'number', range: [0, 100], description: '0~100 스케일 (0=최저, 100=최고)' },
  },
}

// ── Session ZIP Populator (shared across Layer 1/2/3) ──────────────────

interface SessionPopulateOptions {
  session: SessionRow
  utterances: UtteranceRow[]
  speakerMap: Map<string, SpeakerRow>
  topicSegments: unknown[]
  archive: Archiver
  audioMode: 'embedded' | 'reference_only'
  signedUrlMap: Map<string, string> | null
}

async function populateSessionFiles(opts: SessionPopulateOptions): Promise<void> {
  const { session, utterances, speakerMap, topicSegments, archive, audioMode, signedUrlMap } = opts
  const dir = `sessions/${session.id}`
  const sessionTopics = (topicSegments as Array<{ session_id?: string }>)
    .filter(s => s.session_id === session.id)

  archive.append(
    buildUtterancesJsonl(utterances, speakerMap),
    { name: `${dir}/utterances/utterances_${session.id}.jsonl` },
  )
  archive.append(
    buildLabelsJsonl(utterances),
    { name: `${dir}/labels/labels_${session.id}.jsonl` },
  )
  archive.append(
    JSON.stringify(buildQualityReport(session, utterances), null, 2),
    { name: `${dir}/metadata/quality_report.json` },
  )
  archive.append(
    JSON.stringify({ session_id: session.id, pii_flag: session.pii_flag, pii_count: session.pii_count }, null, 2),
    { name: `${dir}/metadata/consent_report.json` },
  )
  archive.append(
    JSON.stringify(buildPiiReport(session.id, utterances), null, 2),
    { name: `${dir}/metadata/pii_report.json` },
  )
  archive.append(
    JSON.stringify(buildAudioManifest(utterances, signedUrlMap, audioMode), null, 2),
    { name: `${dir}/metadata/audio_manifest.json` },
  )
  archive.append(
    JSON.stringify(sessionTopics, null, 2),
    { name: `${dir}/metadata/topic_segments.json` },
  )

  if (audioMode === 'embedded') {
    await appendWavBatch(archive, utterances, dir)
  }
}

// ── Layer 1: Delivery Package ZIP (embedded WAV) ───────────────────────

export async function buildDeliveryPackageZip(packageId: string): Promise<{ sizeBytes: number }> {
  const { data: pkg, error: pkgErr } = await supabaseAdmin
    .from('delivery_packages')
    .select('id, package_number, storage_path')
    .eq('id', packageId)
    .single()
  if (pkgErr || !pkg) throw new Error(`[export-builder] package not found: ${pkgErr?.message}`)

  const { data: linked, error: linkErr } = await supabaseAdmin
    .from('sessions')
    .select('id')
    .eq('in_package_id', packageId)
  if (linkErr) throw new Error(`[export-builder] linked sessions query: ${linkErr.message}`)

  const sessionIds = (linked ?? []).map((r: { id: string }) => r.id)
  if (sessionIds.length === 0) throw new Error(`[export-builder] no sessions in package ${packageId}`)

  const [sessionRows, utterances, topicSegments] = await Promise.all([
    fetchSessionsWithSpeakers(sessionIds),
    fetchUtterances(sessionIds),
    fetchTopicSegments(sessionIds),
  ])

  const speakerMap = buildSpeakerMap(sessionRows)
  const bySession = groupBySession(utterances)
  const { storage_path: storagePath, package_number: packageNumber } =
    pkg as { storage_path: string; package_number: string }

  return streamZipToS3(storagePath, async (archive) => {
    for (const session of sessionRows) {
      await populateSessionFiles({
        session,
        utterances: bySession.get(session.id) ?? [],
        speakerMap,
        topicSegments,
        archive,
        audioMode: 'embedded',
        signedUrlMap: null,
      })
    }
    archive.append(JSON.stringify(LABEL_SCHEMA, null, 2), { name: 'labels/label_schema.json' })
    archive.append(
      JSON.stringify({
        package_number: packageNumber,
        package_id: packageId,
        session_ids: sessionIds,
        generated_at: new Date().toISOString(),
        audio_mode: 'embedded',
      }, null, 2),
      { name: 'manifest.json' },
    )
  })
}

// ── Layer 2: Single Session ZIP (reference_only) ───────────────────────

export async function buildSingleSessionZip(sessionId: string): Promise<string> {
  const storagePath = `exports/${randomUUID()}.zip`

  const [sessionRows, utterances, topicSegments] = await Promise.all([
    fetchSessionsWithSpeakers([sessionId]),
    fetchUtterances([sessionId]),
    fetchTopicSegments([sessionId]),
  ])

  const session = sessionRows[0]
  if (!session) throw new Error(`[export-builder] session not found: ${sessionId}`)

  const speakerMap = buildSpeakerMap(sessionRows)
  const audioKeys = utterances.filter(u => u.storage_path).map(u => u.storage_path!)
  const signedUrlMap = await getSignedUrls(S3_AUDIO_BUCKET, audioKeys, SIGNED_URL_EXPIRES)

  await streamZipToS3(storagePath, async (archive) => {
    await populateSessionFiles({
      session,
      utterances,
      speakerMap,
      topicSegments,
      archive,
      audioMode: 'reference_only',
      signedUrlMap,
    })
    archive.append(JSON.stringify(LABEL_SCHEMA, null, 2), { name: 'labels/label_schema.json' })
    archive.append(
      JSON.stringify({
        session_id: sessionId,
        generated_at: new Date().toISOString(),
        audio_mode: 'reference_only',
        audio_url_expires_at: new Date(Date.now() + SIGNED_URL_EXPIRES * 1000).toISOString(),
      }, null, 2),
      { name: 'manifest.json' },
    )
  })

  return storagePath
}

// ── Layer 3: Batch Session ZIP (reference_only) ────────────────────────

export async function buildBatchZip(sessionIds: string[]): Promise<string> {
  const storagePath = `exports/${randomUUID()}.zip`

  const [sessionRows, utterances, topicSegments] = await Promise.all([
    fetchSessionsWithSpeakers(sessionIds),
    fetchUtterances(sessionIds),
    fetchTopicSegments(sessionIds),
  ])

  const speakerMap = buildSpeakerMap(sessionRows)
  const bySession = groupBySession(utterances)
  const audioKeys = utterances.filter(u => u.storage_path).map(u => u.storage_path!)
  const signedUrlMap = await getSignedUrls(S3_AUDIO_BUCKET, audioKeys, SIGNED_URL_EXPIRES)

  await streamZipToS3(storagePath, async (archive) => {
    for (const session of sessionRows) {
      await populateSessionFiles({
        session,
        utterances: bySession.get(session.id) ?? [],
        speakerMap,
        topicSegments,
        archive,
        audioMode: 'reference_only',
        signedUrlMap,
      })
    }
    archive.append(JSON.stringify(LABEL_SCHEMA, null, 2), { name: 'labels/label_schema.json' })
    archive.append(
      JSON.stringify({
        session_ids: sessionIds,
        generated_at: new Date().toISOString(),
        audio_mode: 'reference_only',
        audio_url_expires_at: new Date(Date.now() + SIGNED_URL_EXPIRES * 1000).toISOString(),
      }, null, 2),
      { name: 'manifest.json' },
    )
  })

  return storagePath
}
