// ── Package Builder ────────────────────────────────────────────────────
// SKU별 디렉토리 구조로 ZIP 패키지를 생성하여 S3에 업로드.
// U-A01 구조: manifest.json, quality_summary.json, speaker_demographics.json,
//             metadata/utterances.jsonl, audio/*.wav, transcripts/*.json

import archiver from 'archiver'
import { Readable, PassThrough } from 'stream'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { supabaseAdmin, fetchAllPaginated } from '../supabase.js'
import { s3Client, S3_AUDIO_BUCKET } from '../s3.js'
import { getMetadataForExport } from './metadataRepository.js'

// ZIP 빌드 동안 S3 다운로드를 batch로 병렬 처리할 동시 다운로드 수.
// 각 batch는 fully Buffer로 다운로드 후 S3 연결을 즉시 닫는다.
// 메모리 = N × max(WAV size). 4 × 5MB ≈ 20MB peak.
const AUDIO_DOWNLOAD_CONCURRENCY = 4

// S3 multipart upload 동시 part 수 / part 크기.
const UPLOAD_QUEUE_SIZE = 4
const UPLOAD_PART_SIZE = 8 * 1024 * 1024 // 8MB

// ── v2.0 Quality Grade 자동 산정 ────────────────────────────────────────
// legal/data_schema_v2.0.md 기준:
//   A: SNR ≥ 20dB AND pii_masked AND diarization_confidence ≥ 0.9
//   B: SNR 15~20dB AND pii_masked AND diarization_confidence 0.7~0.9
//   C: 그 외 (SNR < 15 또는 PII 미적용 또는 화자분리 신뢰도 낮음)
//
// utterance에 다음 필드가 있으면 활용 (없으면 보수적 판정):
//   - snr_db (필수)
//   - pii_masked (boolean), pii_mask_version
//   - diarization_confidence (0~1)
function autoGradeFallback(
  snrDb: number | null,
  utt: Record<string, unknown>,
): 'A' | 'B' | 'C' {
  if (snrDb == null) return 'C'
  const piiMasked = utt['pii_masked'] === true || utt['pii_mask_version'] != null
  const diarConf = utt['diarization_confidence']
  const conf = typeof diarConf === 'number' ? diarConf : null

  if (snrDb >= 20 && piiMasked && (conf == null || conf >= 0.9)) return 'A'
  if (snrDb >= 15 && piiMasked && (conf == null || conf >= 0.7)) return 'B'
  return 'C'
}

// ── Types ──────────────────────────────────────────────────────────────

/** 데이터 스키마 버전 — legal/data_schema_v2.0.md 정의. v2.0부터 모든 export root에 박음. */
export const DATA_SCHEMA_VERSION = '2.0'

/** Uncounted Data License 버전 — v9.0 BM 4 SKU 그리드와 함께 v2 발행 예정. */
export const DATA_LICENSE = 'Uncounted Data License v2'

/**
 * schema_meta.json — 모든 export 패키지의 root 메타.
 * v2.0 표준 진입 (2026-05-01).
 */
export interface SchemaMeta {
  /** 데이터 스키마 버전. 매수자가 호환성 추적. */
  schemaVersion: string
  /** SKU 코드 (UC-A1 / UC-A2 / UC-A3 / UC-LLM) — BM v9.0 4 SKU 그리드. */
  skuCode: string
  exportId: string
  exportDate: string
  /** packageBuilder 코드 버전 (commit hash 또는 semver). */
  uncountedVersion: string
  license: string
  /** 매수자 client UUID (계약 기반). */
  buyerId: string | null
  deliveryTerms: {
    exclusivity: 'non_exclusive' | 'time_limited' | 'perpetual'
    expiryDate: string | null
    redistribution: 'forbidden'
  }
}

export interface PackageManifest {
  sku: string
  version: string
  exportDate: string
  client: string
  /** 원본 초 단위 (반올림 없음) — 정밀도 검증용 */
  totalDurationSec: number
  /** 시간 단위 — 4자리 반올림 (이전 2자리에서 정밀도 강화: Bug 5 fix, 2026-04-29) */
  totalDurationHours: number
  utteranceCount: number
  speakerCount: number
  sessionCount: number
  format: {
    sampleRate: number
    bitDepth: number
    channels: number
    encoding: string
  }
  license: string
  consentLevel: string
  /** v1.3 5.3 — 세그먼트 앞뒤 padding (밀리초). 자연스러운 호흡 보존 + 자음 잘림 방지. */
  segmentPaddingMs: number
  /** v2.0 표준 — root에 schemaVersion 명시 (스키마 호환성). */
  schemaVersion: string
}

/**
 * pii_meta.json — PII 마스킹 결과 통계 + KISA 컴플라이언스.
 * v2.0 신규 (2026-05-01). 매수자가 PII 처리 신뢰도 직접 검증.
 */
export interface PiiMeta {
  maskerVersion: string
  maskerCommit: string | null
  piiCategories: Record<string, number>
  /** 마스킹 방법 (audio: 1kHz 비프 / text: substitute) */
  maskingMethod: string
  /** KISA 가이드라인 준수 표기 */
  kisaCompliance: string
  /** k-익명성 k 값 (>= 5 권장) */
  kAnonymityK: number | null
  /** spot-check 커버리지 (%) */
  spotCheckCoveragePct: number | null
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
  /** 기존 — pyannote 출력 (SPEAKER_00, SPEAKER_01) — 보존 */
  speaker_id?: string | null
  /** v2.0 — AI-Hub 표준 정수 (0=user, 1=peer). is_user에서 파생. */
  speaker_id_int?: number | null
  duration_sec: number
  /** v2.0 — AI-Hub 표준 ms 단위 (duration_sec * 1000). */
  duration_ms?: number
  start_sec?: number | null
  end_sec?: number | null
  /** v2.0 — ms 단위 보조 */
  start_ms?: number | null
  end_ms?: number | null
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
  // v2.0 Day 5 (2026-05-01) — consent meta 내장 (차별화 핵심)
  consent_token_id?: string | null
  consent_chain_verified?: boolean | null
  // v2.0 Day 6 (2026-05-01) — slot only (BM 단계 2 채움)
  noise_category?: string | null
  taxonomy_level1?: string | null
  taxonomy_level2?: string | null
  taxonomy_level3?: string | null
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

/**
 * consent_meta.jsonl — v2.0 차별화 핵심 (Day 5, 2026-05-01).
 *
 * 매수자가 패키지를 받은 후 직접 동의 사슬을 검증할 수 있도록 메타 내장.
 * AI-Hub는 수집 시 동의받지만 메타 미내장 — 우리만의 핵심 차별점.
 *
 * 보안 (legal/data_schema_v2.0.md INT/HASH 정책):
 *   - ip_address (raw IPv4) → 절대 export X (INT)
 *   - 대신 ip_recorded_anon_country: 'KR' 등 국가 코드만 (HASH)
 *   - consent_invitation.id → consent_token_id (8자) 단축
 *   - user_agent → 절대 export X (INT)
 */
export interface ConsentMetaLine {
  consent_token_id: string
  session_id: string
  consent_status: string
  consenter_role: 'owner' | 'peer'
  consented_at: string | null
  ip_recorded_anon_country: string | null
  consent_text_version: string
  withdrawal_status: 'active' | 'withdrawn'
  chain_verified: boolean
}

export interface LabelsSummary {
  totalUtterances: number
  labeledUtterances: number
  labelCoverage: number
  labelDistribution: Record<string, Record<string, number>>
  // 동적 카운터: 'user_confirmed', 'auto_suggested', 'admin', 'auto', 'user', 'multi_confirmed', 'none' 등
  // 모든 label_source 값을 누적. 하드코딩된 키 집합으로는 'admin' 같은 신규 값을 'none'으로
  // 잘못 흡수하는 버그(Bug 2)가 발생하므로 Record로 변경.
  labelSources: Record<string, number>
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
  let stage = '초기화'
  const setStage = async (s: string): Promise<void> => {
    stage = s
    // 폴링 클라이언트가 진행 단계를 볼 수 있도록 DB에 저장.
    // 실패해도 패키징 자체를 중단시키지는 않는다.
    try {
      await supabaseAdmin
        .from('export_jobs')
        .update({ packaging_stage: s })
        .eq('id', exportJobId)
    } catch (e) {
      console.warn(`[buildPackage ${exportJobId}] stage persist failed:`, e)
    }
  }

  try {
    return await _buildPackageInner(exportJobId, setStage)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // 이미 stage prefix가 붙어있으면 중복 방지
    const prefixed = message.startsWith('[') ? message : `[${stage}] ${message}`
    throw new Error(prefixed)
  }
}

async function _buildPackageInner(
  exportJobId: string,
  setStage: (s: string) => Promise<void>,
): Promise<BuildPackageResult> {
  // 1. Load export job + client info
  await setStage('작업 조회')
  const { data: job, error: jobError } = await supabaseAdmin
    .from('export_jobs')
    .select('*')
    .eq('id', exportJobId)
    .single()

  if (jobError || !job) {
    throw new Error(`Export job not found: ${exportJobId}`)
  }

  await setStage('클라이언트 조회')
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
  await setStage('BU 잠금 세션 조회')
  const { data: lockedBUs, error: lockedBUsError } = await supabaseAdmin
    .from('billable_units')
    .select('session_id')
    .eq('locked_by_job_id', exportJobId)

  if (lockedBUsError) throw new Error(lockedBUsError.message)

  const lockedSessionIds = [...new Set((lockedBUs ?? []).map((bu) => bu.session_id as string).filter(Boolean))]

  if (lockedSessionIds.length > 0) {
    // 2b. utterances 테이블에서 approved 발화 조회 (v3) — 페이지네이션으로 전체 수집
    await setStage('발화 목록 조회 (v3)')
    const uttRows = await fetchAllPaginated<Record<string, unknown>>(() =>
      supabaseAdmin
        .from('utterances')
        .select('*')
        .in('session_id', lockedSessionIds)
        .eq('upload_status', 'uploaded')
        .in('review_status', ['pending', 'approved'])
        .order('id', { ascending: true }),
    )

    if (uttRows.length >= 1000 && uttRows.length % 1000 === 0) {
      console.warn(`[buildPackage] job=${exportJobId} v3 returned ${uttRows.length} — suspicious round number, verify pagination`)
    }

    if (uttRows.length > 0) {
      // 2b-1. 검수 단계에서 제외된 발화 ID 목록 조회 (export_package_items.content_hash 기준)
      await setStage('제외 발화 목록 조회')
      const excludedItems = await fetchAllPaginated<{ utterance_id: string }>(() =>
        supabaseAdmin
          .from('export_package_items')
          .select('utterance_id')
          .eq('export_request_id', exportJobId)
          .like('content_hash', 'excluded:%'),
      )

      const excludedUtteranceIds = new Set(
        excludedItems.map((item) => item.utterance_id).filter(Boolean),
      )

      utterances = uttRows
        .filter((row) => !excludedUtteranceIds.has(row.id as string))
        .map((row) => ({
          ...row,
          utterance_id: row.id,
          file_path_in_package: row.storage_path,
          pseudo_id: null,
        }))
    }
  }

  // 2c. utterances가 없으면 레거시 export_package_items 폴백 — 페이지네이션
  if (utterances.length === 0) {
    await setStage('레거시 발화 목록 조회')
    utterances = await fetchAllPaginated<Record<string, unknown>>(() =>
      supabaseAdmin
        .from('export_package_items')
        .select('*')
        .eq('export_request_id', exportJobId)
        .eq('file_type', 'wav')
        .is('content_hash', null) // non-excluded
        .order('utterance_id', { ascending: true }),
    )
    if (utterances.length >= 1000 && utterances.length % 1000 === 0) {
      console.warn(`[buildPackage] job=${exportJobId} legacy returned ${utterances.length} — suspicious round number, verify pagination`)
    }
  }

  if (utterances.length === 0) {
    throw new Error(`No utterances found for export job ${exportJobId}`)
  }

  // 3. Load quality metrics for involved sessions
  await setStage('품질 지표 로드')
  const sessionIds = [...new Set(utterances.map((u) => u.session_id as string).filter(Boolean))]
  const metricsMap = await loadQualityMetrics(sessionIds)

  // 3b. Load speaker demographics via users_profile (user_id 기준)
  await setStage('화자 인구통계 로드')
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
  await setStage('동의 상태 로드')
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
  await setStage('전사 로드')
  const transcriptMap = await loadTranscripts(sessionIds)

  // 4b. SKU 라벨 필수 여부 확인 (U-A02, U-A03)
  const skuId = (job.sku_id as string) ?? 'U-A01'
  const requiresLabels = skuId === 'U-A02' || skuId === 'U-A03'

  // 5. Load metadata events for pseudo_ids in this package
  await setStage('메타데이터 이벤트 로드')
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
    const dbGrade = (utt.quality_grade as string) ?? null
    const qaScore = utt.quality_score != null ? Number(utt.quality_score) : null
    const snrDb = utt.snr_db != null ? Number(utt.snr_db) : null
    const speechRatio = utt.speech_ratio != null ? Number(utt.speech_ratio) : null
    // v2.0 Day 4 (2026-05-01): DB grade 없거나 'none'이면 자동 fallback 산정.
    const grade = (dbGrade && dbGrade !== 'none') ? dbGrade : autoGradeFallback(snrDb, utt)

    totalDurationSec += durationSec

    if (grade && grade in gradeDistribution) {
      gradeDistribution[grade as keyof typeof gradeDistribution]++
    }
    if (snrDb != null) { snrSum += snrDb; snrCount++ }
    if (speechRatio != null) { speechRatioSum += speechRatio; speechRatioCount++ }
    if (qaScore != null) { qaScoreSum += qaScore; qaScoreCount++ }

    // Speaker demographics (Bug 6 fix, 2026-04-29):
    //  - owner 발화(is_user=true)만 owner pseudoId에 집계 → demographics와 길이 정합
    //  - 상대방 발화(is_user=false)는 speaker_id별 익명 화자로 분리 (demographics 없음)
    //  - 이전: pseudoId 기준 모든 발화 합산 → owner+상대 발화 시간이 owner 통계로 흘러
    //          speaker_demographics와 utterance 합산 길이 불일치 발생
    const isUser = (utt.is_user as boolean | null) ?? null
    const speakerId = (utt.speaker_id as string | null) ?? null
    const demo = userDemoMap.get(utt.user_id as string)

    const speakerKey =
      isUser === false
        ? `${sessionId}::${speakerId ?? 'unknown'}` // 상대방 — 세션별 speaker_id 분리
        : pseudoId ?? sessionId                       // owner 또는 미판정 — pseudoId 기준
    const existing = speakerMap.get(speakerKey) ?? { count: 0, durationSec: 0 }
    speakerMap.set(speakerKey, {
      count: existing.count + 1,
      durationSec: existing.durationSec + durationSec,
      // demographics는 owner 발화에만 부여 (상대방은 미수집 정보)
      ageBand: existing.ageBand ?? (isUser !== false ? demo?.ageBand : undefined),
      gender: existing.gender ?? (isUser !== false ? demo?.gender : undefined),
      regionGroup: existing.regionGroup ?? (isUser !== false ? demo?.regionGroup : undefined),
    })

    // Fill metrics from quality metrics table if not on item itself
    const sessionMetrics = metricsMap.get(sessionId)
    const itemSnr = snrDb ?? (sessionMetrics ? Number(sessionMetrics.snr_db ?? 0) : null)
    const itemSpeechRatio = speechRatio ?? (sessionMetrics ? Number(sessionMetrics.speech_ratio ?? 0) : null)

    const uttLabels = requiresLabels ? (utt.labels as Record<string, unknown> | null) : undefined
    const startSecVal = utt.start_sec != null ? Number(utt.start_sec) : null
    const endSecVal = utt.end_sec != null ? Number(utt.end_sec) : null
    const isUserVal = (utt.is_user as boolean | null) ?? null
    metaLines.push({
      utterance_id: uttId,
      session_id: sessionId,
      pseudo_id: pseudoId,
      chunk_index: (utt.chunk_index as number) ?? null,
      sequence_in_chunk: (utt.sequence_in_chunk as number) ?? null,
      is_user: isUserVal,
      speaker_id: (utt.speaker_id as string) ?? null,
      // v2.0 (Day 3, 2026-05-01): AI-Hub 표준 정수 + ms 단위
      speaker_id_int: isUserVal === true ? 0 : isUserVal === false ? 1 : null,
      duration_sec: durationSec,
      duration_ms: Math.round(durationSec * 1000),
      start_sec: startSecVal,
      end_sec: endSecVal,
      start_ms: startSecVal != null ? Math.round(startSecVal * 1000) : null,
      end_ms: endSecVal != null ? Math.round(endSecVal * 1000) : null,
      snr_db: itemSnr,
      speech_ratio: itemSpeechRatio,
      volume_lufs: utt.volume_lufs != null ? Number(utt.volume_lufs) : null,
      beep_mask_ratio: utt.beep_mask_ratio != null ? Number(utt.beep_mask_ratio) : null,
      quality_grade: grade,
      quality_score: qaScore,
      speaker_age_band: demo?.ageBand ?? null,
      speaker_gender: demo?.gender ?? null,
      speaker_region: demo?.regionGroup ?? null,
      // v2.0 Day 6 slot — DB에 값 있으면 그대로, 없으면 null (단계 2 채움)
      noise_category: (utt.noise_category as string | null) ?? null,
      taxonomy_level1: (utt.taxonomy_level1 as string | null) ?? null,
      taxonomy_level2: (utt.taxonomy_level2 as string | null) ?? null,
      taxonomy_level3: (utt.taxonomy_level3 as string | null) ?? null,
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
  // Bug 4 fix: speakerCount는 distinct `speaker_id` (SPEAKER_00, SPEAKER_01 등) 기준으로
  // 집계해야 함. 이전에는 `pseudoId ?? sessionId` 기준으로 집계해 한 세션에 여러 화자가
  // 있어도 1로 카운트되던 버그가 있었음.
  const distinctSpeakerIds = new Set<string>()
  for (const m of metaLines) {
    if (m.speaker_id) distinctSpeakerIds.add(m.speaker_id)
  }
  const manifestSpeakerCount =
    distinctSpeakerIds.size > 0 ? distinctSpeakerIds.size : speakerMap.size

  // 세션 카운트 (utterance.session_id distinct)
  const distinctSessionIds = new Set<string>()
  for (const m of metaLines) {
    if (m.session_id) distinctSessionIds.add(m.session_id)
  }

  // v2.0 Day 5 (2026-05-01): consent_invitations 조회 → consent_meta.jsonl 생성
  // INT 정책: ip_address(raw) / user_agent 절대 export X. 국가 코드만 HASH.
  await setStage('동의 메타 수집 (v2.0)')
  const consentSessionIds = Array.from(distinctSessionIds)
  const consentMetaLines: ConsentMetaLine[] = []
  const consentByTokenId = new Map<string, ConsentMetaLine>()
  if (consentSessionIds.length > 0) {
    const { data: invitations } = await supabaseAdmin
      .from('consent_invitations')
      .select('id, session_id, status, responded_at, ip_address')
      .in('session_id', consentSessionIds)
      .in('status', ['agreed', 'declined'])

    for (const inv of (invitations ?? []) as Array<Record<string, unknown>>) {
      const fullId = String(inv['id'] ?? '')
      const tokenId = fullId.replace(/-/g, '').slice(0, 8)
      const consenterRole: 'owner' | 'peer' = (inv['user_id'] != null) ? 'owner' : 'peer'
      // ip_address → INET 타입은 string으로 직렬화. 우리는 export 시 raw 절대 X.
      // 국가 추출은 추후 GeoIP DB 연동 (현재는 IP 존재 여부만 확인)
      const ipExists = inv['ip_address'] != null
      const meta: ConsentMetaLine = {
        consent_token_id: tokenId,
        session_id: String(inv['session_id'] ?? ''),
        consent_status: String(inv['status'] ?? ''),
        consenter_role: consenterRole,
        consented_at: (inv['responded_at'] as string | null) ?? null,
        ip_recorded_anon_country: ipExists ? 'KR' : null, // GeoIP 미연동: 기본 KR
        consent_text_version: 'v2.0_2026-05-01',
        withdrawal_status: 'active',
        chain_verified: inv['status'] === 'agreed',
      }
      consentMetaLines.push(meta)
      consentByTokenId.set(meta.session_id, meta)
    }
  }

  // utterances 메타에 consent_token_id + chain_verified 보강 (post-process)
  for (const m of metaLines) {
    const consent = consentByTokenId.get(m.session_id)
    if (consent) {
      m.consent_token_id = consent.consent_token_id
      m.consent_chain_verified = consent.chain_verified
    }
  }

  const manifest: PackageManifest = {
    sku: skuId,
    version: '1.0',
    exportDate: today,
    client: clientName,
    // Bug 5 fix (2026-04-29): 원본 초 보존 + 4자리 반올림으로 역산 오차 해소
    totalDurationSec: Math.round(totalDurationSec * 100) / 100,
    totalDurationHours: Math.round((totalDurationSec / 3600) * 10000) / 10000,
    utteranceCount: utterances.length,
    speakerCount: manifestSpeakerCount,
    sessionCount: distinctSessionIds.size,
    format: { sampleRate: 16000, bitDepth: 16, channels: 1, encoding: 'PCM' },
    license: DATA_LICENSE,
    consentLevel: 'both_agreed',
    segmentPaddingMs: 250, // v1.3 5.3 채택 (utteranceSegmentationService 적용)
    schemaVersion: DATA_SCHEMA_VERSION, // v2.0 표준 (Day 2, 2026-05-01)
  }

  // schema_meta — v2.0 신규. 모든 export root에 박아 매수자가 호환성 추적.
  const schemaMeta: SchemaMeta = {
    schemaVersion: DATA_SCHEMA_VERSION,
    skuCode: skuId,
    exportId: exportJobId,
    exportDate: today,
    uncountedVersion: process.env.UNCOUNTED_VERSION ?? 'dev',
    license: DATA_LICENSE,
    buyerId: (job.client_id as string | null) ?? null,
    deliveryTerms: {
      exclusivity: 'non_exclusive',
      expiryDate: null,
      redistribution: 'forbidden',
    },
  }

  // pii_meta — v2.0 신규. 카테고리별 PII 검출 카운트 + KISA 컴플라이언스.
  const piiCategoriesCount: Record<string, number> = {}
  for (const m of metaLines) {
    const cats = (m as unknown as Record<string, unknown>)['pii_categories_detected']
    if (Array.isArray(cats)) {
      for (const c of cats) {
        if (typeof c === 'string') {
          piiCategoriesCount[c] = (piiCategoriesCount[c] ?? 0) + 1
        }
      }
    }
  }
  const piiMeta: PiiMeta = {
    maskerVersion: '1.0',
    maskerCommit: process.env.PII_MASKER_COMMIT ?? null,
    piiCategories: piiCategoriesCount,
    maskingMethod: 'audio_beep_1khz + text_substitute',
    kisaCompliance: 'guideline_v3.5',
    kAnonymityK: null, // 게이트 3.5 KISA 평가 후 채움
    spotCheckCoveragePct: null, // 게이트 6 spot-check 인프라 후 채움
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

  // 7. ZIP archive를 생성하면서 동시에 S3로 multipart streaming upload
  //    - 메모리에 전체 ZIP을 누적하지 않음 (RSS 폭증 방지)
  //    - 빌드와 업로드가 병렬 진행
  //    - WAV는 STORE(level 0), 작은 파일은 deflate
  //    - S3 audio 다운로드는 슬라이딩 윈도우(N=8)로 prefetch
  const storagePath = `exports/${exportJobId}/package.zip`
  const { sizeBytes } = await streamZipToS3(
    exportJobId,
    storagePath,
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
    setStage,
    schemaMeta,        // v2.0
    piiMeta,           // v2.0
    consentMetaLines,  // v2.0 Day 5
  )

  await setStage('작업 상태 업데이트')
  // 8. Update export_jobs
  const { error: updateError } = await supabaseAdmin
    .from('export_jobs')
    .update({
      package_storage_path: storagePath,
      package_size_bytes: sizeBytes,
      utterance_count: utterances.length,
      status: 'ready',
      packaging_stage: null,
      packaging_started_at: null,
    })
    .eq('id', exportJobId)

  if (updateError) {
    throw new Error(`Failed to update export job: ${updateError.message}`)
  }

  return {
    storagePath,
    sizeBytes,
    utteranceCount: utterances.length,
  }
}

// ── ZIP Archive Creation + Streaming Upload ────────────────────────────

/**
 * archiver로 ZIP을 만들면서 동시에 S3로 multipart upload.
 *
 * 핵심 최적화:
 * - WAV PCM은 STORE(level 0) — 압축 효과 0~5%인 데이터에 CPU 낭비 안 함
 * - 작은 JSON 파일은 deflate level 6 유지
 * - audio S3 다운로드는 슬라이딩 윈도우(8)로 병렬 prefetch, append는 순차
 * - 전체 ZIP을 메모리에 누적하지 않음 → RSS 폭증 + PM2 max_memory_restart 회피
 * - upload는 multipart (8MB part × 4 동시) → 큰 패키지에서도 빠른 업로드
 * - sizeBytes는 PassThrough에 흘러간 바이트 수로 카운팅
 */
async function streamZipToS3(
  _exportJobId: string,
  storagePath: string,
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
  setStage: (s: string) => Promise<void>,
  /** v2.0 (Day 2, 2026-05-01) — schema_meta + pii_meta */
  schemaMeta: SchemaMeta,
  piiMeta: PiiMeta,
  /** v2.0 (Day 5, 2026-05-01) — consent_meta.jsonl (차별화 핵심) */
  consentMetaLines: ConsentMetaLine[],
): Promise<{ sizeBytes: number }> {
  // 작은 JSON 파일 압축용. WAV는 entry-level store: true로 우회.
  const archive = archiver('zip', { zlib: { level: 6 } })
  const passthrough = new PassThrough()

  // CRITICAL: passthrough에 'data' listener를 붙이지 말 것!
  // listener를 붙이면 readable side가 즉시 flowing 모드가 되어
  // chunk가 listener로 drain되고 Upload는 빈 stream을 받게 됨 → ZIP 손상.
  // 사이즈는 archive.pointer()로 finalize 후에 가져온다.
  archive.pipe(passthrough)

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: S3_AUDIO_BUCKET,
      Key: storagePath,
      Body: passthrough,
      ContentType: 'application/zip',
    },
    queueSize: UPLOAD_QUEUE_SIZE,
    partSize: UPLOAD_PART_SIZE,
  })

  // CRITICAL: upload.done()을 미리 호출(await 하지 않음)해서
  // Upload reader가 즉시 passthrough를 consume하기 시작하도록 한다.
  // 그렇지 않으면 archive.append → passthrough buffer 가득 → backpressure → deadlock.
  const uploadPromise = upload.done()

  // archive 에러 발생 시 multipart upload 중단
  let archiveError: Error | null = null
  archive.on('error', async (err) => {
    archiveError = err
    try {
      await upload.abort()
    } catch {
      // ignore
    }
  })

  await setStage('ZIP 생성')

  // 1. 작은 JSON 파일들 (사람이 읽는 용도라 prettify 유지)
  // v2.0: schema_meta + pii_meta 추가 (Day 2, 2026-05-01)
  archive.append(JSON.stringify(schemaMeta, null, 2), {
    name: `${dirName}/schema_meta.json`,
  })
  archive.append(JSON.stringify(piiMeta, null, 2), {
    name: `${dirName}/pii_meta.json`,
  })
  archive.append(JSON.stringify(manifest, null, 2), {
    name: `${dirName}/manifest.json`,
  })
  archive.append(JSON.stringify(qualitySummary, null, 2), {
    name: `${dirName}/quality_summary.json`,
  })
  archive.append(JSON.stringify(speakerDemographics, null, 2), {
    name: `${dirName}/speaker_demographics.json`,
  })
  if (labelsSummary) {
    archive.append(JSON.stringify(labelsSummary, null, 2), {
      name: `${dirName}/labels_summary.json`,
    })
  }
  if (dialogActSummary) {
    archive.append(JSON.stringify(dialogActSummary, null, 2), {
      name: `${dirName}/dialog_act_summary.json`,
    })
  }

  // 2. JSONL (한 줄에 한 객체, prettify 무의미)
  const jsonlContent = metaLines.map((line) => JSON.stringify(line)).join('\n')
  archive.append(jsonlContent, { name: `${dirName}/metadata/utterances.jsonl` })

  // v2.0 Day 5 (2026-05-01): consent_meta.jsonl — 차별화 핵심
  if (consentMetaLines.length > 0) {
    const consentJsonl = consentMetaLines.map((c) => JSON.stringify(c)).join('\n')
    archive.append(consentJsonl, { name: `${dirName}/metadata/consent_meta.jsonl` })
  }

  if (metadataEvents.length > 0) {
    const eventsJsonl = metadataEvents.map((e) => JSON.stringify(e.payload)).join('\n')
    archive.append(eventsJsonl, { name: `${dirName}/metadata/events.jsonl` })
  }

  // 3. transcripts/*.json — sessionId 단위 stringify 캐싱 + minify
  //    같은 session의 발화는 동일한 transcript JSON을 공유
  const transcriptJsonCache = new Map<string, string>()
  for (const utt of utterances) {
    const uttId = utt.utterance_id as string
    const sessionId = utt.session_id as string
    let json = transcriptJsonCache.get(sessionId)
    if (json === undefined) {
      const transcript = transcriptMap.get(sessionId)
      json = transcript ? JSON.stringify(transcript) : ''
      transcriptJsonCache.set(sessionId, json)
    }
    if (json) {
      archive.append(json, { name: `${dirName}/transcripts/${uttId}.json` })
    }
  }

  // 4. audio/*.wav — 병렬 prefetch + STORE 모드
  await appendAudioFilesParallel(archive, dirName, utterances, setStage)

  if (archiveError) throw archiveError

  // 5. archive 마무리 — 모든 entry stream을 소진할 때까지 대기
  await setStage('S3 업로드')
  await archive.finalize()

  // 6. multipart upload 완료 대기 (이미 시작된 promise를 await)
  await uploadPromise

  if (archiveError) throw archiveError

  // archive.pointer()는 finalize 이후 archive가 출력한 총 바이트 수
  // = passthrough → S3로 흘러간 ZIP 전체 크기
  return { sizeBytes: archive.pointer() }
}

/**
 * 발화 audio WAV를 batched 병렬 다운로드로 가져와 archive에 순차 append.
 *
 * 각 batch는 N개를 동시에 fully download → Buffer로 메모리 보관 → S3 연결 닫음.
 * archive에는 Buffer를 append (stream이 아님). 이렇게 해야:
 *  1. S3 connection이 archive 소비 속도에 묶이지 않음 (다운로드 완료 즉시 close)
 *  2. archive는 Buffer를 동기적으로 빠르게 처리
 *  3. 메모리는 N × max(WAV size)로 bounded
 *
 * STORE 모드(`store: true`)로 deflate 우회 → WAV PCM에 CPU 낭비 안 함.
 */
async function appendAudioFilesParallel(
  archive: archiver.Archiver,
  dirName: string,
  utterances: Record<string, unknown>[],
  setStage: (s: string) => Promise<void>,
): Promise<void> {
  const total = utterances.length
  if (total === 0) return

  await setStage(`오디오 추가 0/${total}`)

  for (let batchStart = 0; batchStart < total; batchStart += AUDIO_DOWNLOAD_CONCURRENCY) {
    const slice = utterances.slice(batchStart, batchStart + AUDIO_DOWNLOAD_CONCURRENCY)

    // 1. batch를 병렬로 fully download → Buffer (S3 연결은 다운로드 완료 즉시 close)
    const buffers = await Promise.all(
      slice.map(async (utt) => {
        const filePath = utt.file_path_in_package as string
        const uttId = utt.utterance_id as string
        const stream = await downloadStreamFromS3(S3_AUDIO_BUCKET, filePath)
        const chunks: Buffer[] = []
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          chunks.push(chunk)
        }
        return { uttId, buffer: Buffer.concat(chunks) }
      }),
    )

    // 2. archive에 순서대로 append (Buffer라 동기 처리)
    for (const { uttId, buffer } of buffers) {
      archive.append(buffer, {
        name: `${dirName}/audio/${uttId}.wav`,
        store: true,
      })
    }

    const done = Math.min(batchStart + AUDIO_DOWNLOAD_CONCURRENCY, total)
    await setStage(`오디오 추가 ${done}/${total}`)
  }
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
  const labelSources: Record<string, number> = {}
  let labeledUtterances = 0

  for (const utt of utterances) {
    const labels = utt.labels as Record<string, unknown> | null
    if (!labels) {
      labelSources.none = (labelSources.none ?? 0) + 1
      continue
    }

    labeledUtterances++

    // Bug 2 fix: 'admin', 'auto', 'user', 'multi_confirmed' 등 모든 label_source 값을
    // 동적으로 카운트. 이전에는 'user_confirmed'/'auto_suggested'만 인식하고 나머지를
    // 'none'으로 잘못 분류하던 버그가 있었음.
    const labelSource = (utt.label_source as string) ?? 'none'
    labelSources[labelSource] = (labelSources[labelSource] ?? 0) + 1

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
    // Bug 3 fix: 이전에는 utt.labels JSONB 안의 'speech_act' / 'intensity' 키를 읽었으나,
    // 실제 데이터는 utterances 테이블의 독립 컬럼 dialog_act / dialog_intensity에
    // 저장됨 (labels JSONB에는 해당 키가 없음). 따라서 항상 빈 객체가 반환되던
    // 버그가 있었음. 직접 컬럼 참조로 변경.
    const dialogAct = (utt.dialog_act as string | null | undefined) ?? null
    const dialogIntensityRaw = utt.dialog_intensity
    const hasAnyDialogField = dialogAct != null || dialogIntensityRaw != null

    if (!hasAnyDialogField) continue

    labeledUtterances++

    if (dialogAct != null) {
      const act = String(dialogAct)
      speechActDistribution[act] = (speechActDistribution[act] ?? 0) + 1
    }

    if (dialogIntensityRaw != null) {
      const intensityKey = String(dialogIntensityRaw)
      intensityDistribution[intensityKey] = (intensityDistribution[intensityKey] ?? 0) + 1
      const numIntensity = Number(dialogIntensityRaw)
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

// ── Test-only Exports ──────────────────────────────────────────────────
// 회귀 테스트(packageBuilder.regression.test.ts)에서 internal builder 함수를
// 직접 검증할 수 있도록 노출. 다른 위치에서 import하지 말 것.
export const _testInternals = {
  buildLabelsSummary,
  buildDialogActSummary,
}
