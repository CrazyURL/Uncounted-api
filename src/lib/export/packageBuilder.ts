// ── Package Builder ────────────────────────────────────────────────────
// SKU별 디렉토리 구조로 ZIP 패키지를 생성하여 S3에 업로드.
// U-A01 구조: manifest.json, quality_summary.json, speaker_demographics.json,
//             metadata/utterances.jsonl, audio/*.wav, transcripts/*.json

import archiver from 'archiver'
import { Readable, PassThrough } from 'stream'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { supabaseAdmin } from '../supabase.js'
import { s3Client, S3_AUDIO_BUCKET, uploadObject } from '../s3.js'
import { getMetadataForExport } from './metadataRepository.js'

// ── Types ──────────────────────────────────────────────────────────────

export interface PackageManifest {
  sku: string
  version: string
  exportDate: string
  client: string
  totalDurationHours: number
  utteranceCount: number
  speakerCount: number
  format: {
    sampleRate: number
    bitDepth: number
    channels: number
    encoding: string
  }
  license: string
  consentLevel: string
}

export interface QualitySummary {
  totalUtterances: number
  gradeDistribution: { A: number; B: number; C: number }
  avgSnrDb: number | null
  avgSpeechRatio: number | null
  avgQaScore: number | null
}

export interface SpeakerDemographic {
  pseudoId: string
  utteranceCount: number
  totalDurationSec: number
  ageBand?: string
  gender?: string
  regionGroup?: string
}

export interface UtteranceMetaLine {
  utterance_id: string
  session_id: string
  pseudo_id: string | null
  duration_sec: number
  snr_db: number | null
  speech_ratio: number | null
  quality_grade: string | null
  qa_score: number | null
}

export interface BuildPackageResult {
  storagePath: string
  sizeBytes: number
  utteranceCount: number
}

// ── Main Builder ───────────────────────────────────────────────────────

/**
 * Build a ZIP package for an export job.
 * 1. Load included utterances from export_package_items
 * 2. Download WAVs, load transcripts, load quality metrics
 * 3. Assemble ZIP with U-A01 directory structure
 * 4. Upload ZIP to S3
 * 5. Update export_jobs record
 */
export async function buildPackage(
  exportJobId: string,
): Promise<BuildPackageResult> {
  // 1. Load export job + client info
  const { data: job, error: jobError } = await supabaseAdmin
    .from('export_jobs')
    .select('*')
    .eq('id', exportJobId)
    .single()

  if (jobError || !job) {
    throw new Error(`Export job not found: ${exportJobId}`)
  }

  let clientName = 'Unknown Client'
  if (job.client_id) {
    const { data: client } = await supabaseAdmin
      .from('clients')
      .select('name')
      .eq('id', job.client_id)
      .single()
    if (client?.name) clientName = client.name
  }

  // 2. Load included utterances (file_type='wav', non-excluded)
  const { data: items, error: itemsError } = await supabaseAdmin
    .from('export_package_items')
    .select('*')
    .eq('export_request_id', exportJobId)
    .eq('file_type', 'wav')
    .is('content_hash', null) // non-excluded
    .order('utterance_id', { ascending: true })

  if (itemsError) {
    throw new Error(`Failed to load package items: ${itemsError.message}`)
  }

  const utterances = (items ?? []) as Record<string, unknown>[]
  if (utterances.length === 0) {
    throw new Error(`No utterances found for export job ${exportJobId}`)
  }

  // 3. Load quality metrics for involved sessions
  const sessionIds = [...new Set(utterances.map((u) => u.session_id as string).filter(Boolean))]
  const metricsMap = await loadQualityMetrics(sessionIds)

  // 3b. Load speaker demographics via sessions → users_profile
  const { data: profileRows } = await supabaseAdmin
    .from('sessions')
    .select('id, pid, users_profile(age_band, gender, region_group)')
    .in('id', sessionIds)

  const sessionDemoMap = new Map<string, { ageBand?: string; gender?: string; regionGroup?: string }>()
  for (const row of (profileRows ?? []) as Record<string, unknown>[]) {
    const profile = row.users_profile as Record<string, unknown> | null
    if (profile) {
      sessionDemoMap.set(row.id as string, {
        ageBand: (profile.age_band as string) ?? undefined,
        gender: (profile.gender as string) ?? undefined,
        regionGroup: (profile.region_group as string) ?? undefined,
      })
    }
  }

  // 4. Load transcripts for involved sessions
  const transcriptMap = await loadTranscripts(sessionIds)

  // 5. Load metadata events for pseudo_ids in this package
  const pseudoIds = [
    ...new Set(utterances.map((u) => u.pseudo_id as string).filter(Boolean)),
  ]
  const metadataEvents = pseudoIds.length > 0
    ? await getMetadataForExport(pseudoIds)
    : []

  // 6. Build ZIP in memory
  const today = new Date().toISOString().slice(0, 10)
  const sanitizedClient = clientName.replace(/[^a-zA-Z0-9가-힣_-]/g, '_')
  const packageDirName = `U-A01_${today}_${sanitizedClient}`

  // Gather speaker demographics
  const speakerMap = new Map<string, { count: number; durationSec: number; ageBand?: string; gender?: string; regionGroup?: string }>()
  const metaLines: UtteranceMetaLine[] = []
  let totalDurationSec = 0
  const gradeDistribution = { A: 0, B: 0, C: 0 }
  let snrSum = 0
  let snrCount = 0
  let speechRatioSum = 0
  let speechRatioCount = 0
  let qaScoreSum = 0
  let qaScoreCount = 0

  for (const utt of utterances) {
    const uttId = utt.utterance_id as string
    const sessionId = utt.session_id as string
    const pseudoId = (utt.pseudo_id as string) ?? null
    const durationSec = Number(utt.duration_sec ?? 0)
    const grade = (utt.quality_grade as string) ?? null
    const qaScore = utt.qa_score != null ? Number(utt.qa_score) : null
    const snrDb = utt.snr_db != null ? Number(utt.snr_db) : null
    const speechRatio = utt.speech_ratio != null ? Number(utt.speech_ratio) : null

    totalDurationSec += durationSec

    if (grade && grade in gradeDistribution) {
      gradeDistribution[grade as keyof typeof gradeDistribution]++
    }
    if (snrDb != null) { snrSum += snrDb; snrCount++ }
    if (speechRatio != null) { speechRatioSum += speechRatio; speechRatioCount++ }
    if (qaScore != null) { qaScoreSum += qaScore; qaScoreCount++ }

    // Speaker demographics
    const speakerKey = pseudoId ?? sessionId
    const existing = speakerMap.get(speakerKey) ?? { count: 0, durationSec: 0 }
    const demo = sessionDemoMap.get(sessionId)
    speakerMap.set(speakerKey, {
      count: existing.count + 1,
      durationSec: existing.durationSec + durationSec,
      ageBand: existing.ageBand ?? demo?.ageBand,
      gender: existing.gender ?? demo?.gender,
      regionGroup: existing.regionGroup ?? demo?.regionGroup,
    })

    // Fill metrics from quality metrics table if not on item itself
    const sessionMetrics = metricsMap.get(sessionId)
    const itemSnr = snrDb ?? (sessionMetrics ? Number(sessionMetrics.snr_db ?? 0) : null)
    const itemSpeechRatio = speechRatio ?? (sessionMetrics ? Number(sessionMetrics.speech_ratio ?? 0) : null)

    metaLines.push({
      utterance_id: uttId,
      session_id: sessionId,
      pseudo_id: pseudoId,
      duration_sec: durationSec,
      snr_db: itemSnr,
      speech_ratio: itemSpeechRatio,
      quality_grade: grade,
      qa_score: qaScore,
    })
  }

  // Build manifest
  const manifest: PackageManifest = {
    sku: 'U-A01',
    version: '1.0',
    exportDate: today,
    client: clientName,
    totalDurationHours: Math.round((totalDurationSec / 3600) * 100) / 100,
    utteranceCount: utterances.length,
    speakerCount: speakerMap.size,
    format: { sampleRate: 16000, bitDepth: 16, channels: 1, encoding: 'PCM' },
    license: 'Uncounted Data License v1',
    consentLevel: 'both_agreed',
  }

  // Build quality summary
  const qualitySummary: QualitySummary = {
    totalUtterances: utterances.length,
    gradeDistribution,
    avgSnrDb: snrCount > 0 ? Math.round((snrSum / snrCount) * 100) / 100 : null,
    avgSpeechRatio: speechRatioCount > 0 ? Math.round((speechRatioSum / speechRatioCount) * 10000) / 10000 : null,
    avgQaScore: qaScoreCount > 0 ? Math.round((qaScoreSum / qaScoreCount) * 100) / 100 : null,
  }

  // Build speaker demographics
  const speakerDemographics: SpeakerDemographic[] = Array.from(speakerMap.entries()).map(
    ([pseudoId, stats]) => ({
      pseudoId,
      utteranceCount: stats.count,
      totalDurationSec: Math.round(stats.durationSec * 100) / 100,
      ageBand: stats.ageBand,
      gender: stats.gender,
      regionGroup: stats.regionGroup,
    }),
  )

  // 7. Create ZIP archive
  const zipBuffer = await createZipArchive(
    packageDirName,
    manifest,
    qualitySummary,
    speakerDemographics,
    metaLines,
    utterances,
    transcriptMap,
    metadataEvents,
  )

  // 7. Upload to S3
  const storagePath = `exports/${exportJobId}/package.zip`
  await uploadObject(S3_AUDIO_BUCKET, storagePath, zipBuffer, 'application/zip')

  // 8. Update export_jobs
  const { error: updateError } = await supabaseAdmin
    .from('export_jobs')
    .update({
      package_storage_path: storagePath,
      package_size_bytes: zipBuffer.length,
      utterance_count: utterances.length,
      status: 'ready',
    })
    .eq('id', exportJobId)

  if (updateError) {
    throw new Error(`Failed to update export job: ${updateError.message}`)
  }

  return {
    storagePath,
    sizeBytes: zipBuffer.length,
    utteranceCount: utterances.length,
  }
}

// ── ZIP Archive Creation ───────────────────────────────────────────────

async function createZipArchive(
  dirName: string,
  manifest: PackageManifest,
  qualitySummary: QualitySummary,
  speakerDemographics: SpeakerDemographic[],
  metaLines: UtteranceMetaLine[],
  utterances: Record<string, unknown>[],
  transcriptMap: Map<string, TranscriptData>,
  metadataEvents: Array<{ payload: Record<string, unknown> }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } })
    const chunks: Buffer[] = []
    const passthrough = new PassThrough()

    passthrough.on('data', (chunk: Buffer) => chunks.push(chunk))
    passthrough.on('end', () => resolve(Buffer.concat(chunks)))
    passthrough.on('error', reject)

    archive.on('error', reject)
    archive.pipe(passthrough)

    // manifest.json
    archive.append(
      JSON.stringify(manifest, null, 2),
      { name: `${dirName}/manifest.json` },
    )

    // quality_summary.json
    archive.append(
      JSON.stringify(qualitySummary, null, 2),
      { name: `${dirName}/quality_summary.json` },
    )

    // speaker_demographics.json
    archive.append(
      JSON.stringify(speakerDemographics, null, 2),
      { name: `${dirName}/speaker_demographics.json` },
    )

    // metadata/utterances.jsonl
    const jsonlContent = metaLines.map((line) => JSON.stringify(line)).join('\n')
    archive.append(jsonlContent, { name: `${dirName}/metadata/utterances.jsonl` })

    // metadata/events.jsonl (수집기 메타데이터: U-M05~U-M18, U-P01)
    if (metadataEvents.length > 0) {
      const eventsJsonl = metadataEvents
        .map((e) => JSON.stringify(e.payload))
        .join('\n')
      archive.append(eventsJsonl, { name: `${dirName}/metadata/events.jsonl` })
    }

    // transcripts/*.json
    for (const utt of utterances) {
      const uttId = utt.utterance_id as string
      const sessionId = utt.session_id as string
      const transcript = transcriptMap.get(sessionId)

      if (transcript) {
        archive.append(
          JSON.stringify(transcript, null, 2),
          { name: `${dirName}/transcripts/${uttId}.json` },
        )
      }
    }

    // audio/*.wav — append as deferred streams to avoid loading all into memory at once
    const appendAudioFiles = async () => {
      for (const utt of utterances) {
        const uttId = utt.utterance_id as string
        const filePath = utt.file_path_in_package as string

        try {
          const wavStream = await downloadStreamFromS3(S3_AUDIO_BUCKET, filePath)
          archive.append(wavStream, { name: `${dirName}/audio/${uttId}.wav` })
        } catch (err: any) {
          console.error(`Failed to include WAV for ${uttId}: ${err.message}`)
        }
      }

      await archive.finalize()
    }

    appendAudioFiles().catch(reject)
  })
}

// ── Data Loading Helpers ───────────────────────────────────────────────

interface TranscriptData {
  text: string
  words?: Array<{ word: string; start: number; end: number; probability?: number }>
  summary?: string
}

async function loadQualityMetrics(
  sessionIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>()
  if (sessionIds.length === 0) return map

  const BATCH = 500
  for (let i = 0; i < sessionIds.length; i += BATCH) {
    const batch = sessionIds.slice(i, i + BATCH)
    const { data } = await supabaseAdmin
      .from('bu_quality_metrics')
      .select('session_id, snr_db, speech_ratio, quality_score, quality_grade')
      .in('session_id', batch)

    for (const row of data ?? []) {
      map.set(row.session_id as string, row as Record<string, unknown>)
    }
  }

  return map
}

async function loadTranscripts(
  sessionIds: string[],
): Promise<Map<string, TranscriptData>> {
  const map = new Map<string, TranscriptData>()
  if (sessionIds.length === 0) return map

  const BATCH = 500
  for (let i = 0; i < sessionIds.length; i += BATCH) {
    const batch = sessionIds.slice(i, i + BATCH)
    const { data } = await supabaseAdmin
      .from('transcripts')
      .select('session_id, text, words, summary')
      .in('session_id', batch)

    for (const row of data ?? []) {
      map.set(row.session_id as string, {
        text: row.text as string,
        words: (row.words as TranscriptData['words']) ?? undefined,
        summary: (row.summary as string) ?? undefined,
      })
    }
  }

  return map
}

/** Download an S3 object as a Readable stream */
async function downloadStreamFromS3(
  bucket: string,
  key: string,
): Promise<Readable> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  )

  if (!response.Body) {
    throw new Error(`S3 object body is empty: ${key}`)
  }

  return response.Body as Readable
}
