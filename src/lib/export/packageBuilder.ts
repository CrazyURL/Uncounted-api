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
  chunk_index?: number | null
  sequence_in_chunk?: number | null
  is_user?: boolean | null
  speaker_id?: string | null
  duration_sec: number
  start_sec?: number | null
  end_sec?: number | null
  snr_db: number | null
  speech_ratio: number | null
  volume_lufs?: number | null
  beep_mask_ratio?: number | null
  quality_grade: string | null
  quality_score: number | null
  // Demographics (U-A01+)
  speaker_age_band?: string | null
  speaker_gender?: string | null
  speaker_region?: string | null
  // Consent (U-A01+)
  consent_status?: string | null
  consent_version?: string | null
  // U-A02 labels (flattened)
  label_relationship?: string | null
  label_purpose?: string | null
  label_domain?: string | null
  label_tone?: string | null
  label_noise?: string | null
  label_source?: string | null
  label_confidence?: number | null
  // U-A03
  dialog_act?: string | null
  dialog_intensity?: number | null
  speech_act_events?: unknown[] | null
  interaction_mode?: string | null
}

export interface BuildPackageResult {
  storagePath: string
  sizeBytes: number
  utteranceCount: number
}

export interface LabelsSummary {
  totalUtterances: number
  labeledUtterances: number
  labelCoverage: number
  labelDistribution: Record<string, Record<string, number>>
  labelSources: { user_confirmed: number; auto_suggested: number; none: number }
}

export interface DialogActSummary {
  totalUtterances: number
  labeledUtterances: number
  speechActDistribution: Record<string, number>
  intensityDistribution: Record<string, number>
  avgIntensity: number | null
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

  // 2. Load included utterances — v3: utterances 테이블 우선, 없으면 export_package_items 폴백
  let utterances: Record<string, unknown>[] = []

  // 2a. BU 잠금된 세션 목록 추출
  const { data: lockedBUs } = await supabaseAdmin
    .from('billable_units')
    .select('session_id')
    .eq('locked_by_job_id', exportJobId)

  const lockedSessionIds = [...new Set((lockedBUs ?? []).map((bu) => bu.session_id as string).filter(Boolean))]

  if (lockedSessionIds.length > 0) {
    // 2b. utterances 테이블에서 approved 발화 조회 (v3)
    const { data: uttRows, error: uttError } = await supabaseAdmin
      .from('utterances')
      .select('*')
      .in('session_id', lockedSessionIds)
      .eq('upload_status', 'uploaded')
      .in('review_status', ['pending', 'approved'])
      .order('id', { ascending: true })

    if (!uttError && uttRows && uttRows.length > 0) {
      // 2b-1. 검수 단계에서 제외된 발화 ID 목록 조회 (export_package_items.content_hash 기준)
      const { data: excludedItems } = await supabaseAdmin
        .from('export_package_items')
        .select('utterance_id')
        .eq('export_request_id', exportJobId)
        .like('content_hash', 'excluded:%')

      const excludedUtteranceIds = new Set(
        (excludedItems ?? []).map((item) => item.utterance_id as string).filter(Boolean),
      )

      utterances = (uttRows as Record<string, unknown>[])
        .filter((row) => !excludedUtteranceIds.has(row.id as string))
        .map((row) => ({
          ...row,
          utterance_id: row.id,
          file_path_in_package: row.storage_path,
          pseudo_id: null,
        }))
    }
  }

  // 2c. utterances가 없으면 레거시 export_package_items 폴백
  if (utterances.length === 0) {
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

    utterances = (items ?? []) as Record<string, unknown>[]
  }

  if (utterances.length === 0) {
    throw new Error(`No utterances found for export job ${exportJobId}`)
  }

  // 3. Load quality metrics for involved sessions
  const sessionIds = [...new Set(utterances.map((u) => u.session_id as string).filter(Boolean))]
  const metricsMap = await loadQualityMetrics(sessionIds)

  // 3b. Load speaker demographics via users_profile (user_id 기준)
  const userIds = [...new Set(utterances.map((u) => u.user_id as string).filter(Boolean))]
  const { data: profileRows } = await supabaseAdmin
    .from('users_profile')
    .select('user_id, age_band, gender, region_group')
    .in('user_id', userIds)

  const userDemoMap = new Map<string, { ageBand?: string; gender?: string; regionGroup?: string }>()
  for (const row of (profileRows ?? []) as Record<string, unknown>[]) {
    userDemoMap.set(row.user_id as string, {
      ageBand: (row.age_band as string) ?? undefined,
      gender: (row.gender as string) ?? undefined,
      regionGroup: (row.region_group as string) ?? undefined,
    })
  }

  // 3c. Load consent_status from locked BUs (session_id 기준)
  const buConsentMap = new Map<string, string>()
  if (lockedBUs && lockedBUs.length > 0) {
    const { data: buConsentRows } = await supabaseAdmin
      .from('billable_units')
      .select('session_id, consent_status')
      .eq('locked_by_job_id', exportJobId)
    for (const row of (buConsentRows ?? []) as Record<string, unknown>[]) {
      buConsentMap.set(row.session_id as string, (row.consent_status as string) ?? 'PRIVATE')
    }
  }

  // 4. Load transcripts for involved sessions
  const transcriptMap = await loadTranscripts(sessionIds)

  // 4b. SKU 라벨 필수 여부 확인 (U-A02, U-A03)
  const skuId = (job.sku_id as string) ?? 'U-A01'
  const requiresLabels = skuId === 'U-A02' || skuId === 'U-A03'

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
  const packageDirName = `${skuId}_${today}_${sanitizedClient}`

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
    const qaScore = utt.quality_score != null ? Number(utt.quality_score) : null
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
    const demo = userDemoMap.get(utt.user_id as string)
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

    const uttLabels = requiresLabels ? (utt.labels as Record<string, unknown> | null) : undefined
    metaLines.push({
      utterance_id: uttId,
      session_id: sessionId,
      pseudo_id: pseudoId,
      chunk_index: (utt.chunk_index as number) ?? null,
      sequence_in_chunk: (utt.sequence_in_chunk as number) ?? null,
      is_user: (utt.is_user as boolean) ?? null,
      speaker_id: (utt.speaker_id as string) ?? null,
      duration_sec: durationSec,
      start_sec: utt.start_sec != null ? Number(utt.start_sec) : null,
      end_sec: utt.end_sec != null ? Number(utt.end_sec) : null,
      snr_db: itemSnr,
      speech_ratio: itemSpeechRatio,
      volume_lufs: utt.volume_lufs != null ? Number(utt.volume_lufs) : null,
      beep_mask_ratio: utt.beep_mask_ratio != null ? Number(utt.beep_mask_ratio) : null,
      quality_grade: grade,
      quality_score: qaScore,
      speaker_age_band: demo?.ageBand ?? null,
      speaker_gender: demo?.gender ?? null,
      speaker_region: demo?.regionGroup ?? null,
      consent_status: buConsentMap.get(sessionId) ?? null,
      consent_version: null,
      ...(requiresLabels && {
        label_relationship: (uttLabels?.relationship as string) ?? null,
        label_purpose: (uttLabels?.purpose as string) ?? null,
        label_domain: (uttLabels?.domain as string) ?? null,
        label_tone: (uttLabels?.tone as string) ?? null,
        label_noise: (uttLabels?.noise as string) ?? null,
        label_source: (utt.label_source as string) ?? null,
        label_confidence: utt.label_confidence != null ? Number(utt.label_confidence) : null,
      }),
      ...(skuId === 'U-A03' && {
        dialog_act: (utt.dialog_act as string) ?? null,
        dialog_intensity: utt.dialog_intensity != null ? Number(utt.dialog_intensity) : null,
        speech_act_events: (utt.speech_act_events as unknown[]) ?? [],
        interaction_mode: (utt.interaction_mode as string) ?? null,
      }),
    })
  }

  // Build manifest
  const manifest: PackageManifest = {
    sku: skuId,
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

  // Build SKU-specific summaries (utterance 기반)
  const labelsSummary: LabelsSummary | null = skuId === 'U-A02' || skuId === 'U-A03'
    ? buildLabelsSummary(utterances)
    : null

  const dialogActSummary: DialogActSummary | null = skuId === 'U-A03'
    ? buildDialogActSummary(utterances)
    : null

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
    labelsSummary,
    dialogActSummary,
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
  labelsSummary: LabelsSummary | null,
  dialogActSummary: DialogActSummary | null,
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

    // labels_summary.json (U-A02)
    if (labelsSummary) {
      archive.append(
        JSON.stringify(labelsSummary, null, 2),
        { name: `${dirName}/labels_summary.json` },
      )
    }

    // dialog_act_summary.json (U-A03)
    if (dialogActSummary) {
      archive.append(
        JSON.stringify(dialogActSummary, null, 2),
        { name: `${dirName}/dialog_act_summary.json` },
      )
    }

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

// ── SKU Summary Builders ───────────────────────────────────────────────

function buildLabelsSummary(
  utterances: Record<string, unknown>[],
): LabelsSummary {
  const labelDistribution: Record<string, Record<string, number>> = {}
  const labelSources = { user_confirmed: 0, auto_suggested: 0, none: 0 }
  let labeledUtterances = 0

  for (const utt of utterances) {
    const labels = utt.labels as Record<string, unknown> | null
    if (!labels) {
      labelSources.none++
      continue
    }

    labeledUtterances++

    const labelSource = (utt.label_source as string) ?? null
    if (labelSource === 'user_confirmed') labelSources.user_confirmed++
    else if (labelSource === 'auto_suggested') labelSources.auto_suggested++
    else labelSources.none++

    for (const [key, value] of Object.entries(labels)) {
      if (!labelDistribution[key]) labelDistribution[key] = {}
      const strVal = String(value)
      labelDistribution[key][strVal] = (labelDistribution[key][strVal] ?? 0) + 1
    }
  }

  return {
    totalUtterances: utterances.length,
    labeledUtterances,
    labelCoverage: utterances.length > 0 ? Math.round((labeledUtterances / utterances.length) * 10000) / 10000 : 0,
    labelDistribution,
    labelSources,
  }
}

function buildDialogActSummary(
  utterances: Record<string, unknown>[],
): DialogActSummary {
  const speechActDistribution: Record<string, number> = {}
  const intensityDistribution: Record<string, number> = {}
  let intensitySum = 0
  let intensityCount = 0
  let labeledUtterances = 0

  for (const utt of utterances) {
    const labels = utt.labels as Record<string, unknown> | null
    if (!labels) continue

    labeledUtterances++

    if (labels.speech_act != null) {
      const act = String(labels.speech_act)
      speechActDistribution[act] = (speechActDistribution[act] ?? 0) + 1
    }

    if (labels.intensity != null) {
      const intensityKey = String(labels.intensity)
      intensityDistribution[intensityKey] = (intensityDistribution[intensityKey] ?? 0) + 1
      const numIntensity = Number(labels.intensity)
      if (!isNaN(numIntensity)) {
        intensitySum += numIntensity
        intensityCount++
      }
    }
  }

  return {
    totalUtterances: utterances.length,
    labeledUtterances,
    speechActDistribution,
    intensityDistribution,
    avgIntensity: intensityCount > 0 ? Math.round((intensitySum / intensityCount) * 100) / 100 : null,
  }
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
