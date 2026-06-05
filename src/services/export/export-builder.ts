/**
 * Export v2 — Layer 2 (단일 세션) ZIP 빌더.
 *
 * 기존 `lib/export/packageBuilder.ts` (BM v10.0/U-A01) 와 별도 경로.
 * v2 외부 ZIP 구조 + 안전선 13개 강제 + safety scan.
 *
 * Layer 1 (delivery_package.zip) / Layer 3 (batch_export.zip) 은 placeholder.
 */

import { createWriteStream, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { Readable } from 'stream'
import archiver from 'archiver'
import { GetObjectCommand } from '@aws-sdk/client-s3'

import { supabaseAdmin } from '../../lib/supabase.js'
import { s3Client, S3_AUDIO_BUCKET } from '../../lib/s3.js'
import {
  sanitizeExternalLabelOrigin,
  sanitizeExternalMethod,
  sanitizeExternalSpeakerRole,
} from '../../lib/export/transforms.js'
import { isExportEligible } from '../../lib/export/eligibility.js'
import { isUtteranceDeliverable } from '../../lib/export/utteranceDeliverability.js'
import { mapUtteranceRowToSyncInput } from '../../lib/export/utteranceToInternal.js'
import { applySyncIntegrityGate, type SyncQualityReport } from '../../lib/export/syncIntegrityGate.js'
import {
  buildUtteranceCountMap,
  filterOrphanUtterances,
  isOrphanFilterEnabled,
  summarizeDroppedOrphans,
} from '../../lib/export/orphanFilter.js'
import { computeSessionQualityTier } from '../../lib/export/sessionQualityTier.js'
import { computeLabelConfidenceTier } from '../../lib/export/labelConfidenceTier.js'

/** embedded WAV S3 다운로드 동시성 (packageBuilder 와 동일 정책). */
const AUDIO_DOWNLOAD_CONCURRENCY = 4

import { validateExportSafety } from './safety-checks.js'
import { validateDeliveryRecords } from './delivery-schema.js'
import { signPackage } from './package-signing.js'
import { LABEL_SCHEMA_JSON } from './label-schema.js'
import type {
  AudioExportMode,
  BuildSessionExportOptions,
  BuildSessionExportResult,
  ExportManifest,
  ExportSafetySummary,
} from './export-types.js'

// ── DB 행 타입 (필요한 컬럼만 표기, 나머지는 unknown) ──────────────────

interface SessionRow {
  id: string
  pid: string | null
  user_id?: string | null
  consent_status?: string | null
  review_status?: string | null
  session_dataset_eligible?: boolean | null
  session_quality_tier?: string | null
  session_topic_summary?: string | null
  audio_metadata?: Record<string, unknown> | null
  conversation_context?: Record<string, unknown> | null
  support_quality_labels?: Record<string, unknown> | null
  created_at?: string | null
  /** mig027 — worker.py persist_results 가 신규 N 으로 갱신. orphan filter 게이트 컬럼. */
  utterance_count?: number | null
  [key: string]: unknown
}

interface UtteranceRow {
  id: string
  session_id: string
  sequence_order: number
  speaker_id: string
  is_user?: boolean | null
  start_sec: number | string
  end_sec: number | string
  duration_sec: number | string | null
  storage_path: string | null
  transcript_text: string | null
  labels?: Record<string, unknown> | null
  emotion?: string | null
  emotion_confidence?: number | string | null
  dialog_act?: string | null
  dialog_intensity?: number | null
  label_source?: string | null
  label_confidence?: number | string | null
  auto_label_model_version?: string | null
  pii_intervals?: unknown
  speech_act_events?: unknown
  numeric_patterns?: unknown
  utterance_form?: Record<string, unknown> | null
  // Task 5: 화자중첩(cross-talk) 메타. null = 미산출(평가 안 됨) → false 로 단정 금지.
  is_overlapping?: boolean | null
  overlap_count?: number | string | null
  overlap_total_sec?: number | string | null
  overlap_ratio?: number | string | null
  overlap_intervals?: unknown
  review_status?: string | null
  upload_status?: string | null
  [key: string]: unknown
}

// ── 메인 진입점 ──────────────────────────────────────────────────────────

export async function buildSessionExportZip(
  options: BuildSessionExportOptions,
): Promise<BuildSessionExportResult> {
  const {
    sessionId,
    audioExportMode: requestedMode,
    includeRestricted = false,
    outputDir,
    enableSyncIntegrityGate = false,
  } = options

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('buildSessionExportZip: sessionId required')
  }

  // 외부 API 계약은 audioExportMode 만 받는다. includeAudio 는 내부 파생값.
  // (옵션의 includeAudio 입력은 무시 — 불일치 방지.)
  const audioExportMode: AudioExportMode =
    requestedMode === 'embedded' ? 'embedded' : 'reference_only'
  const includeAudio = audioExportMode === 'embedded'

  const { session, utterances: loadedUtterances, lineageRun } = await loadSessionContext(sessionId)

  // 기본은 로드된 전체 발화. 일반 납품 플로우에서는 발화 단위 품질 필터를 적용한다.
  let utterances = loadedUtterances

  if (!includeRestricted) {
    const eligibility = isExportEligible(session)
    if (!eligibility.eligible) {
      throw new Error(
        `buildSessionExportZip: session ${sessionId} not export-eligible (${eligibility.reason}). ` +
          `set includeRestricted=true to override (안전선 #5).`,
      )
    }

    // 발화 단위 납품 품질 필터 (PR2): 부적격 발화(excluded_low_quality / needs_* /
    // pii_unresolved / D·F / 미승인 C / 품질 미측정)는 패키지에서 제외.
    // includeRestricted=true (admin 진단/재다운로드) 시에는 미적용 — 전체 동봉.
    utterances = loadedUtterances.filter((u) => isUtteranceDeliverable(u).included)
  }

  // Sync Integrity Gate (D1) — opt-in. 발화별 audio↔transcript↔timing↔pii 참조무결성을
  // 검증하고, 정합이 깨진 발화는 fail-closed 로 제외(timing 보정 X). 비활성(default)이면
  // 아래 블록을 건너뛰어 기존 export 동작과 동일.
  let syncQualityReport: SyncQualityReport | null = null
  if (enableSyncIntegrityGate) {
    const syncInputs = utterances.map((u) => mapUtteranceRowToSyncInput(u))
    const outcome = applySyncIntegrityGate(syncInputs, { audioExportMode })
    const keptIds = new Set(outcome.kept.map((k) => k.utterance_id))
    utterances = utterances.filter((u) => keptIds.has(u.id))
    syncQualityReport = outcome.report
  }

  const baseDir = outputDir ?? os.tmpdir()
  const stagingDir = await fs.mkdtemp(path.join(baseDir, `export-v2-${sessionId}-`))

  try {
    await writeAllArtifacts(stagingDir, {
      session,
      utterances,
      audioExportMode,
      includeAudio,
      includeRestricted,
      syncQualityReport,
      lineageRun,
    })

    // ZIP 빌드 직전 safety scan.
    const safety = await validateExportSafety(stagingDir)
    if (safety.violations.length > 0) {
      throw new Error(
        `Export safety violation (${safety.violations.length} item${
          safety.violations.length === 1 ? '' : 's'
        }):\n  - ${safety.violations.slice(0, 10).join('\n  - ')}`,
      )
    }

    const zipPath = path.join(
      baseDir,
      `session_export_${sessionId}.zip`,
    )
    await assembleZip(stagingDir, zipPath)

    // 패키지 암호서명(C2PA 경량 대안): ZIP SHA-256 + (키 있으면) Ed25519 서명 → <zip>.SIGNATURE.json
    const signature = await signPackage(zipPath, new Date().toISOString())

    const manifest = buildManifest({
      session,
      utterances,
      audioExportMode,
      includeAudio,
      includeRestricted,
    })

    return { zipPath, manifest, safety, signature }
  } finally {
    // staging dir 정리는 호출자가 zip 파일을 옮긴 후로 미뤄도 됨.
    // 본 단계에서는 staging dir 를 유지하여 검증 grep 이 가능하도록 보존하지 않고 zip 후 삭제.
    try {
      await fs.rm(stagingDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}

// ── Layer 1 / Layer 3 placeholders ───────────────────────────────────────

export async function buildDeliveryPackageZip(): Promise<never> {
  throw new Error('Layer 1 (delivery_package.zip) export v2 not implemented yet')
}

export async function buildBatchExportZip(): Promise<never> {
  throw new Error('Layer 3 (batch_export.zip) export v2 not implemented yet')
}

// ── DB 조회 ───────────────────────────────────────────────────────────────

interface SessionContext {
  session: SessionRow
  utterances: UtteranceRow[]
  // Task 8: 최신 처리 run provenance (없으면 null — 미처리/lineage 이전 세션)
  lineageRun: Record<string, unknown> | null
}

// internal — testability 를 위해 export (외부 API 계약은 buildSessionExportZip 만).
export async function loadSessionContext(sessionId: string): Promise<SessionContext> {
  const sessionResp = await supabaseAdmin
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle()

  if (sessionResp.error) {
    throw new Error(`loadSessionContext: sessions query failed: ${sessionResp.error.message}`)
  }
  if (!sessionResp.data) {
    throw new Error(`loadSessionContext: session ${sessionId} not found`)
  }

  const utteranceResp = await supabaseAdmin
    .from('utterances')
    .select('*')
    .eq('session_id', sessionId)
    .order('sequence_order', { ascending: true })

  if (utteranceResp.error) {
    throw new Error(
      `loadSessionContext: utterances query failed: ${utteranceResp.error.message}`,
    )
  }

  const session = sessionResp.data as SessionRow
  const allUtterances = (utteranceResp.data ?? []) as UtteranceRow[]

  // Task 8: 이 세션의 최신 provenance run (null-safe — 실패/부재 시 null, export 무중단)
  let lineageRun: Record<string, unknown> | null = null
  try {
    const lr = await supabaseAdmin
      .from('lineage_runs')
      .select('pipeline_git_sha,pipeline_version,service_version,model_versions,gate_states,created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!lr.error && lr.data) lineageRun = lr.data as Record<string, unknown>
  } catch {
    // lineage optional — 미적용 환경에서도 export 정상
  }

  // orphan utterance 필터 (export hardening, 디렉터 옵션 X 2026-05-29).
  //   sequence_order > session.utterance_count 인 행은 stale orphan 으로 drop.
  //   curated marker (pii_reviewed_at / pii_masked_at / quality_reviewed_by) 와 무관.
  //   설계: scripts/analysis/export_hardening_orphan_filter_20260529.md
  //   feature flag EXPORT_ORPHAN_FILTER_ENABLED='false' 명시 시에만 우회 (default true).
  //   single-session 경로라 sessions 추가 query 불필요 (session.utterance_count 그대로 사용).
  if (isOrphanFilterEnabled()) {
    const utteranceCountMap = buildUtteranceCountMap([
      { id: session.id, utterance_count: session.utterance_count },
    ])
    const outcome = filterOrphanUtterances(allUtterances, utteranceCountMap)
    if (outcome.dropped.length > 0) {
      const summary = summarizeDroppedOrphans(
        outcome.dropped as Array<{ id?: string | null; session_id?: string | null; sequence_order?: number | null }>,
      )
      const count = utteranceCountMap.get(session.id) ?? 0
      console.warn(
        `[loadSessionContext] session=${sessionId} dropped ${summary.totalDropped} orphan utterances ` +
          `(utterance_count=${count}, sample_ids=${JSON.stringify(summary.sampleUtteranceIds)})`,
      )
    }
    return { session, utterances: outcome.kept, lineageRun }
  }

  return { session, utterances: allUtterances, lineageRun }
}

// ── 아티팩트 작성 ────────────────────────────────────────────────────────

interface WriteContext {
  session: SessionRow
  utterances: UtteranceRow[]
  audioExportMode: AudioExportMode
  includeAudio: boolean
  includeRestricted: boolean
  /** Sync Integrity Gate(D1) 활성 시에만 채워짐. 있으면 metadata/ 에 동봉. */
  syncQualityReport?: SyncQualityReport | null
  /** Task 8: 최신 처리 run provenance (없으면 null). call_*.json 에 동봉. */
  lineageRun?: Record<string, unknown> | null
}

async function writeAllArtifacts(
  stagingDir: string,
  ctx: WriteContext,
): Promise<void> {
  const { session, utterances, audioExportMode, includeAudio, includeRestricted } = ctx
  const lineageRun = ctx.lineageRun ?? null
  const sid = session.id

  await fs.mkdir(path.join(stagingDir, 'calls'), { recursive: true })
  await fs.mkdir(path.join(stagingDir, 'utterances'), { recursive: true })
  await fs.mkdir(path.join(stagingDir, 'labels'), { recursive: true })
  await fs.mkdir(path.join(stagingDir, 'metadata'), { recursive: true })
  if (includeAudio) {
    await fs.mkdir(path.join(stagingDir, 'audio', sid), { recursive: true })
  }

  const manifest = buildManifest({
    session,
    utterances,
    audioExportMode,
    includeAudio,
    includeRestricted,
  })

  await writeJson(path.join(stagingDir, 'manifest.json'), manifest)
  await writeText(path.join(stagingDir, 'README_DATASET_CARD.md'), buildReadme(session))

  // calls/
  await writeJson(
    path.join(stagingDir, 'calls', `call_${sid}.json`),
    buildCallJson(session, utterances, audioExportMode, lineageRun),
  )
  await writeText(
    path.join(stagingDir, 'calls', `call_${sid}.txt`),
    buildCallTxt(utterances),
  )

  // utterances/ — JSON Schema 검증(하드게이트): 구조 위반 시 출하 차단.
  const utteranceLines = utterances.map((u) => buildUtteranceLine(u, sid))
  const schemaCheck = validateDeliveryRecords(utteranceLines)
  if (!schemaCheck.valid) {
    throw new Error(
      `Delivery schema violation (${schemaCheck.errorCount} in ${schemaCheck.recordCount} records):\n  - ` +
        schemaCheck.errors.slice(0, 10).join('\n  - '),
    )
  }
  await writeJsonl(
    path.join(stagingDir, 'utterances', `utterances_${sid}.jsonl`),
    utteranceLines,
  )

  // labels/
  await writeJsonl(
    path.join(stagingDir, 'labels', `labels_${sid}.jsonl`),
    utterances.map((u) => buildLabelLine(u, sid, audioExportMode)),
  )
  await writeJson(
    path.join(stagingDir, 'labels', 'label_schema.json'),
    LABEL_SCHEMA_JSON,
  )

  // metadata/
  const metaDir = path.join(stagingDir, 'metadata')
  await writeJson(path.join(metaDir, 'dataset_summary.json'), buildDatasetSummary(session, utterances))
  await writeJson(path.join(metaDir, 'dataset_quality_report.json'), buildDatasetQualityReport(session, utterances))
  await writeJson(path.join(metaDir, 'quality_report.json'), buildQualityReport(utterances))
  await writeJson(path.join(metaDir, 'label_report.json'), buildLabelReport(utterances))
  await writeJson(path.join(metaDir, 'pii_report.json'), buildPiiReport(utterances))
  await writeJson(path.join(metaDir, 'consent_report.json'), await buildConsentReport(session))
  await writeJson(path.join(metaDir, 'audio_manifest.json'), buildAudioManifest(utterances, sid, audioExportMode))
  await writeJson(path.join(metaDir, 'number_pattern_report.json'), buildNumberPatternReport(utterances))
  await writeJson(path.join(metaDir, 'audio_metadata_report.json'), buildAudioMetadataReport(session))
  // 패키지 루트: 약관·상업이용권리 문서(플랫폼 상수=value/enum 중 enum, 1개만 최상위).
  await fs.writeFile(path.join(stagingDir, 'CONSENT_TERMS_AND_LICENSE.md'), CONSENT_TERMS_AND_LICENSE_MD, 'utf-8')
  await writeJson(path.join(metaDir, 'utterance_form_report.json'), buildUtteranceFormReport(utterances))
  await writeJson(path.join(metaDir, 'processing_summary.json'), buildProcessingSummary(audioExportMode, includeAudio, includeRestricted))
  // Sync Integrity Gate(D1) 리포트 — 게이트 활성 시에만 동봉(미활성 시 파일 미생성 → 기존 ZIP 구조 불변).
  if (ctx.syncQualityReport) {
    await writeJson(path.join(metaDir, 'sync_quality_report.json'), ctx.syncQualityReport)
  }

  // audio/ — embedded 모드만 실제 WAV 동봉. reference_only 는 audio_manifest 참조만.
  // storage_path 는 builder 내부에서만 S3 fetch 키로 사용 (외부 ZIP 미노출).
  if (includeAudio && audioExportMode === 'embedded') {
    await downloadAudioFilesToStaging(stagingDir, sid, utterances)
  }
}

/**
 * embedded WAV 를 S3 에서 batched 병렬 다운로드 → staging/audio/{sid}/utt_{id}.wav 로 기록.
 *
 * packageBuilder.appendAudioFilesParallel 의 검증된 다운로드/병렬 정책만 포팅.
 * (billable_units / SKU / ledger / client 의존성 미반입.)
 * ZIP 은 staging 디렉토리 전체를 담으므로 파일 기록만으로 audio/ 가 포함된다.
 */
async function downloadAudioFilesToStaging(
  stagingDir: string,
  sessionId: string,
  utterances: UtteranceRow[],
): Promise<void> {
  const targets = utterances.filter(
    (u) => typeof u.storage_path === 'string' && (u.storage_path as string).length > 0,
  )
  if (targets.length === 0) return

  const audioDir = path.join(stagingDir, 'audio', sessionId)
  await fs.mkdir(audioDir, { recursive: true })

  for (let i = 0; i < targets.length; i += AUDIO_DOWNLOAD_CONCURRENCY) {
    const slice = targets.slice(i, i + AUDIO_DOWNLOAD_CONCURRENCY)
    await Promise.all(
      slice.map(async (u) => {
        const key = u.storage_path as string
        const stream = await downloadStreamFromS3(S3_AUDIO_BUCKET, key)
        const chunks: Buffer[] = []
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          chunks.push(chunk as Buffer)
        }
        const dest = path.join(audioDir, `utt_${u.id}.wav`)
        await fs.writeFile(dest, Buffer.concat(chunks))
      }),
    )
  }
}

async function downloadStreamFromS3(bucket: string, key: string): Promise<Readable> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  )
  if (!response.Body) {
    throw new Error(`downloadStreamFromS3: S3 object body is empty: ${key}`)
  }
  return response.Body as Readable
}

// ── manifest ─────────────────────────────────────────────────────────────

function buildManifest(ctx: WriteContext): ExportManifest {
  const piiCount = ctx.utterances.reduce((sum, u) => sum + safeArrayLen(u.pii_intervals), 0)
  return {
    manifest_version: 'v2',
    session_id: ctx.session.id,
    audio_export_mode: ctx.audioExportMode,
    include_audio: ctx.includeAudio,
    include_restricted: ctx.includeRestricted,
    generated_at: new Date().toISOString(),
    counts: {
      utterances: ctx.utterances.length,
      labels: ctx.utterances.length,
      pii_labels: piiCount,
    },
  }
}

// ── README ───────────────────────────────────────────────────────────────

function buildReadme(session: SessionRow): string {
  const lines = [
    '# Uncounted Export v2 — Dataset Card',
    '',
    `- session_id: ${session.id}`,
    '- format: Layer 2 (single session)',
    '- license: see delivery agreement',
    '',
    '## Safety',
    '- PII intervals 의 원문은 외부 ZIP 에 포함되지 않습니다.',
    '- numeric_patterns 는 마스킹된 토큰만 포함합니다.',
    '- 화자 역할은 후보값으로만 표기됩니다 (owner_candidate / counterparty_candidate / unknown).',
    '',
  ]
  return lines.join('\n')
}

// ── calls/ ───────────────────────────────────────────────────────────────

// 안전선 #6 — provenance 외부 노출 sanitize.
//   model_versions: raw 모델명(whisperx/pyannote 등)을 메서드 enum 으로 일반화
//     (auto_label_model_version line 639 과 동일 정책을 provenance 에도 일관 적용).
//   version 문자열: 인라인 `#` 주석(내부 메모·날짜 누출, 예 "v2-...  # v2 activation 20260531")
//     제거 + 잔여 standalone 6+ 숫자열 제거(numeric_sensitive 차단).
function sanitizeVersionString(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const noComment = v.split('#')[0].trim()
  const scrubbed = noComment.replace(/(?<![\dA-Za-z._-])\d{6,}(?![\dA-Za-z._-])/g, '').trim()
  return scrubbed.length > 0 ? scrubbed : null
}

function sanitizeModelVersions(mv: unknown): Record<string, string> | null {
  if (!mv || typeof mv !== 'object' || Array.isArray(mv)) return null
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(mv as Record<string, unknown>)) {
    out[k] = sanitizeExternalMethod(val)
  }
  return Object.keys(out).length > 0 ? out : null
}

// Task 8: provenance 외부 노출 정화 (안전선 #6 — 내부 모델명/버전·git SHA·게이트
// 내부값 비노출). raw 상세는 내부 lineage_runs 테이블에만 보존하고, 바이어 산출물엔
// processed_at + 일반화 method 카테고리(automatic/supervised_model/...)만 노출.
function sanitizeProvenance(
  lineageRun: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!lineageRun) return null
  const mv = (lineageRun.model_versions ?? {}) as Record<string, unknown>
  const methods = Array.from(
    new Set(
      Object.values(mv)
        .map((v) => sanitizeExternalMethod(v))
        .filter((m) => m !== 'not_available'),
    ),
  )
  return {
    processed_at: lineageRun.created_at ?? null,
    methods,
  }
}

function buildCallJson(
  session: SessionRow,
  utterances: UtteranceRow[],
  audioExportMode: AudioExportMode,
  lineageRun: Record<string, unknown> | null = null,
): Record<string, unknown> {
  // PR-C: DB 값 우선 → utterances quality_grade 분포 fallback. DB write 0.
  const tier = computeSessionQualityTier({
    db_value: session.session_quality_tier ?? null,
    utterances,
  })
  return {
    session_id: session.id,
    created_at: session.created_at ?? null,
    audio_export_mode: audioExportMode,
    audio_metadata: session.audio_metadata ?? null,
    session_topic_summary: session.session_topic_summary ?? null,
    session_quality_tier: tier.tier,
    tier_source: tier.source,
    utterance_count: utterances.length,
    // Task 8: 데이터 족보(provenance) — 안전선 #6 정화본만(sanitizeProvenance).
    // git SHA·gate_states·버전문자열(largev3 등 모델힌트)은 내부 lineage_runs 에만 보존,
    // 바이어 산출물엔 processed_at + 일반화 method 카테고리만. null=미처리(날조 금지).
    provenance: sanitizeProvenance(lineageRun),
  }
}

// ── PII 텍스트 마스킹 (시간 구간 기반) ────────────────────────────────────
// detector 가 산출한 pii_intervals(startSec/endSec/piiType)와 transcript_words 의
// word 시간을 매칭해, 겹치는 word 를 piiType 토큰으로 치환한다. char offset 이
// 없으므로 시간 교차로 단어를 찾는다. DB 는 변경하지 않고(원본 provenance 유지),
// 외부로 나가는 ZIP 텍스트에만 적용한다(안전선 #3: 평문 PII 미노출).
// 토큰은 voice-api P0 표준(2026-06-04)과 통일: [PII_<타입>]. 기존 [이름]/[IP] 폐기 →
// DB transcript_text 의 [PII_*] 와 납품물 토큰 체계 일치(타입 보존, downstream LLM 정합).
const _PII_TOKEN: Record<string, string> = {
  이름: '[PII_이름]',
  IP주소: '[PII_IP주소]',
  전화번호: '[PII_전화번호]',
  주민등록번호: '[PII_주민등록번호]',
  계좌번호: '[PII_계좌번호]',
  카드번호: '[PII_카드번호]',
  여권번호: '[PII_여권번호]',
  운전면허번호: '[PII_운전면허번호]',
  이메일: '[PII_이메일]',
}

function _piiToken(piiType: string): string {
  // 미등록 타입(extended numeric_sensitive_like 등)도 [PII_<타입>] 로 일관.
  return _PII_TOKEN[piiType] ?? `[PII_${piiType}]`
}

interface _MaskWord { word: string; start: number; end: number }

function _coerceWords(raw: unknown): _MaskWord[] {
  if (!Array.isArray(raw)) return []
  const out: _MaskWord[] = []
  for (const w of raw) {
    if (!w || typeof w !== 'object') continue
    const o = w as Record<string, unknown>
    const word = typeof o.word === 'string' ? o.word : ''
    const start = toNumOrNull(o.start)
    const end = toNumOrNull(o.end)
    if (!word || start === null || end === null) continue
    out.push({ word, start, end })
  }
  return out
}

/**
 * pii_intervals 시간과 겹치는 word 를 piiType 토큰으로 치환한 텍스트를 반환한다.
 * - transcript_words 가 없거나 pii_intervals 가 없으면 원본 텍스트를 그대로 반환.
 * - 시간 교차 판정: word 와 interval 이 조금이라도 겹치면(>0) 마스킹.
 */
function maskTextByPiiIntervals(u: UtteranceRow): string {
  const text = typeof u.transcript_text === 'string' ? u.transcript_text : ''
  if (!text) return text
  const intervals = sanitizePiiLabels(u.pii_intervals)
  if (intervals.length === 0) return text
  const words = _coerceWords((u as Record<string, unknown>).transcript_words)
  if (words.length === 0) return text

  const masked = words.map((w) => {
    for (const iv of intervals) {
      const s = iv.startSec as number
      const e = iv.endSec as number
      if (w.start < e && w.end > s) {
        return _piiToken(iv.piiType as string)
      }
    }
    return w.word
  })
  const joined = masked.join(' ').replace(/\s+/g, ' ').trim()
  return joined || text
}

function buildCallTxt(utterances: UtteranceRow[]): string {
  return utterances
    .map((u) => {
      const label = typeof u.speaker_id === 'string' && u.speaker_id.length > 0
        ? u.speaker_id
        : 'UNKNOWN'
      const text = maskTextByPiiIntervals(u)
      return `[${label}] ${text}`
    })
    .join('\n')
}

// ── utterances/ ──────────────────────────────────────────────────────────

function buildUtteranceLine(u: UtteranceRow, sessionId: string): Record<string, unknown> {
  return {
    utterance_id: u.id,
    session_id: sessionId,
    sequence_order: u.sequence_order,
    start_sec: toNum(u.start_sec),
    end_sec: toNum(u.end_sec),
    duration_sec: toNum(u.duration_sec),
    // speaker_label: 익명 diarization 라벨 (예: SPEAKER_00). 그대로 노출.
    speaker_label: typeof u.speaker_id === 'string' ? u.speaker_id : 'UNKNOWN',
    // speaker_role_candidate: 안전선 #1 후보값만 (확정값 X).
    speaker_role_candidate: sanitizeExternalSpeakerRole(u.speaker_id),
    text: maskTextByPiiIntervals(u),
    // Task 5: 핵심 필터 1개만 코어 파일에 노출(상세는 labels/*.jsonl 의 overlap 객체).
    // null = 미산출(평가 안 됨) — false 로 단정하지 않는다.
    is_overlapping: u.is_overlapping ?? null,
  }
}

// ── labels/ ──────────────────────────────────────────────────────────────

function buildLabelLine(
  u: UtteranceRow,
  sessionId: string,
  audioExportMode: AudioExportMode,
): Record<string, unknown> {
  const piiLabels = sanitizePiiLabels(u.pii_intervals)
  const speechAct = pickSpeechAct(u.speech_act_events)
  const numericPatterns = sanitizeNumericPatterns(u.numeric_patterns)
  const labelConfidence = toNumOrNull(u.label_confidence)
  // PR-D: label_confidence > emotion_confidence > null. pure helper, DB write 0.
  const tier = computeLabelConfidenceTier({
    label_confidence: u.label_confidence,
    emotion_confidence: u.emotion_confidence,
  })

  const line: Record<string, unknown> = {
    utterance_id: u.id,
    session_id: sessionId,
    sequence_order: u.sequence_order,
    start_sec: toNum(u.start_sec),
    end_sec: toNum(u.end_sec),
    text: maskTextByPiiIntervals(u),

    speaker_label: typeof u.speaker_id === 'string' ? u.speaker_id : 'UNKNOWN',
    speaker_role_candidate: sanitizeExternalSpeakerRole(u.speaker_id),
    label_origin: sanitizeExternalLabelOrigin(u.label_source),
    label_version: sanitizeExternalMethod(u.auto_label_model_version),
    confidence_tier: tier.tier,
    label_confidence: labelConfidence,

    audio_export_mode: audioExportMode,
    audio_metadata_ref: sessionId,

    auto_labels: {
      emotion: buildAutoEmotion(u),
      speech_act: speechAct,
    },

    utterance_form: u.utterance_form ?? null,
    numeric_patterns: numericPatterns,
    conversation_context: null,
    emotion_detail: null,
    pii_labels: piiLabels,
    // Task 5: 화자중첩 메타 (null = 미산출). 바이어 필터: overlap.is_overlapping === false.
    overlap: buildOverlap(u),
  }

  return line
}

// Task 5: overlap intervals 정제 (jsonb → [{start_sec,end_sec}] 숫자 보장).
function sanitizeOverlapIntervals(raw: unknown): Array<{ start_sec: number; end_sec: number }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ start_sec: number; end_sec: number }> = []
  for (const it of raw) {
    if (it && typeof it === 'object') {
      const s = toNumOrNull((it as Record<string, unknown>).start_sec)
      const e = toNumOrNull((it as Record<string, unknown>).end_sec)
      if (s !== null && e !== null) out.push({ start_sec: s, end_sec: e })
    }
  }
  return out
}

// Task 5: utterance 단위 overlap 메타 객체.
// ★무결성: is_overlapping 이 null/undefined(미산출)면 null 반환 — false 로 단정하지 않는다.
// false 는 "프리미엄(비중첩) 보장"이므로 평가 안 된 발화를 false 로 내보내면 오염 위험.
function buildOverlap(u: UtteranceRow): Record<string, unknown> | null {
  if (u.is_overlapping === null || u.is_overlapping === undefined) return null
  return {
    is_overlapping: u.is_overlapping === true,
    count: toNumOrNull(u.overlap_count) ?? 0,
    total_sec: toNumOrNull(u.overlap_total_sec) ?? 0,
    ratio: toNumOrNull(u.overlap_ratio) ?? 0,
    intervals: sanitizeOverlapIntervals(u.overlap_intervals),
  }
}

function sanitizePiiLabels(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  const out: Array<Record<string, unknown>> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const startSec = toNumOrNull(obj.startSec ?? obj.start_sec)
    const endSec = toNumOrNull(obj.endSec ?? obj.end_sec)
    const maskType = typeof obj.maskType === 'string'
      ? obj.maskType
      : typeof obj.mask_type === 'string'
        ? obj.mask_type
        : 'unknown'
    const piiType = typeof obj.piiType === 'string'
      ? obj.piiType
      : typeof obj.pii_type === 'string'
        ? obj.pii_type
        : 'unknown'
    if (startSec === null || endSec === null) continue
    out.push({ startSec, endSec, maskType, piiType })
  }
  return out
}

function sanitizeNumericPatterns(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  const out: Array<Record<string, unknown>> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const type = typeof obj.type === 'string' ? obj.type : null
    const surfaceMasked = typeof obj.surface_masked === 'string' ? obj.surface_masked : null
    const normalizedMasked = typeof obj.normalized_masked === 'string' ? obj.normalized_masked : null
    if (!type || !surfaceMasked || !normalizedMasked) continue
    out.push({
      type,
      surface_masked: surfaceMasked,
      normalized_masked: normalizedMasked,
      pii_related: obj.pii_related === true,
    })
  }
  return out
}

function pickSpeechAct(raw: unknown): Record<string, unknown> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const first = raw[0]
  if (!first || typeof first !== 'object') return null
  const obj = first as Record<string, unknown>
  return {
    value: typeof obj.value === 'string' ? obj.value : typeof obj.act === 'string' ? obj.act : null,
    confidence: toNumOrNull(obj.confidence),
    method: sanitizeExternalMethod(obj.method),
  }
}

/**
 * 자동 추정 emotion 라벨 (사람 검수 X). flat 컬럼 기반.
 *
 * 버그 수정: 기존 extractEmotion 은 `labels` JSONB(사람 검수용, 대부분 null)에서
 * 읽어 auto_labels.emotion 이 항상 null 이었다. flat 컬럼(emotion/emotion_confidence/
 * auto_label_model_version)에서 직접 매핑한다.
 *
 * - value: u.emotion (긍정/중립/부정)
 * - confidence: u.emotion_confidence (NUMERIC → number)
 * - source: 'automatic' — 자동 추정 marker (최상위 label_origin 과 구분)
 * - model_version: 안전선 #6 일반화 (raw 모델명 ZIP 노출 금지)
 *
 * emotion 미산출(null/empty) 이면 null 반환 → 정직하게 null 노출.
 */
function buildAutoEmotion(u: UtteranceRow): Record<string, unknown> | null {
  const value = typeof u.emotion === 'string' && u.emotion.length > 0 ? u.emotion : null
  if (value === null) return null
  return {
    value,
    confidence: toNumOrNull(u.emotion_confidence),
    source: 'automatic',
    model_version: sanitizeExternalMethod(u.auto_label_model_version),
  }
}

// ── metadata 리포트 ──────────────────────────────────────────────────────

function buildDatasetSummary(session: SessionRow, utterances: UtteranceRow[]): Record<string, unknown> {
  const totalDuration = utterances.reduce((sum, u) => sum + (toNum(u.duration_sec) ?? 0), 0)
  // PR-C: tier 산정 (DB 우선 → utterances 분포 fallback). dataset_quality_report 와 동일 값.
  const tier = computeSessionQualityTier({
    db_value: session.session_quality_tier ?? null,
    utterances,
  })
  return {
    session_id: session.id,
    utterance_count: utterances.length,
    total_duration_sec: round(totalDuration, 3),
    consent_status: session.consent_status ?? null,
    review_status: session.review_status ?? null,
    session_quality_tier: tier.tier,
    tier_source: tier.source,
    notes: [
      '안전선 #5: review_status=approved + consent_status=both_agreed + session_dataset_eligible!=false 에 한해 export.',
    ],
  }
}

function buildDatasetQualityReport(
  session: SessionRow,
  utterances: UtteranceRow[],
): Record<string, unknown> {
  const grades: Record<string, number> = {}
  for (const u of utterances) {
    const g = (u as Record<string, unknown>).quality_grade
    if (typeof g === 'string') grades[g] = (grades[g] ?? 0) + 1
  }
  // PR-C: tier 산정 (DB 우선 → utterances 분포 fallback). 산정 근거 (tier_source /
  // tier_reason / ab_ratio / df_ratio) 동봉 — buyer/admin 의 신뢰 근거.
  const tier = computeSessionQualityTier({
    db_value: session.session_quality_tier ?? null,
    utterances,
  })
  return {
    session_id: session.id,
    quality_grade_distribution: grades,
    session_quality_tier: tier.tier,
    tier_source: tier.source,
    tier_reason: tier.tier_reason,
    tier_metrics: {
      total: tier.metrics.total,
      ab_ratio: round(tier.metrics.ab_ratio, 4),
      df_ratio: round(tier.metrics.df_ratio, 4),
    },
  }
}

function buildQualityReport(utterances: UtteranceRow[]): Record<string, unknown> {
  const snr: number[] = []
  const speechRatio: number[] = []
  for (const u of utterances) {
    const snrVal = toNumOrNull((u as Record<string, unknown>).snr_db)
    const srVal = toNumOrNull((u as Record<string, unknown>).speech_ratio)
    if (snrVal !== null) snr.push(snrVal)
    if (srVal !== null) speechRatio.push(srVal)
  }
  return {
    summary: {
      utterance_count: utterances.length,
      snr_db_avg: avg(snr),
      speech_ratio_avg: avg(speechRatio),
    },
    notes: ['안전선 #6: 내부 모델명 / 학습 출처 키워드 포함 금지.'],
  }
}

function buildLabelReport(utterances: UtteranceRow[]): Record<string, unknown> {
  const originCounts: Record<string, number> = {}
  const versionCounts: Record<string, number> = {}
  for (const u of utterances) {
    const origin = sanitizeExternalLabelOrigin(u.label_source)
    originCounts[origin] = (originCounts[origin] ?? 0) + 1
    const version = sanitizeExternalMethod(u.auto_label_model_version)
    versionCounts[version] = (versionCounts[version] ?? 0) + 1
  }
  return {
    summary: { utterance_count: utterances.length },
    distribution: {
      label_origin: originCounts,
      label_version: versionCounts,
    },
    notes: ['안전선 #6/#12: label_origin / label_version 은 외부 5종 allowlist 로만 노출.'],
  }
}

function buildPiiReport(utterances: UtteranceRow[]): Record<string, unknown> {
  let total = 0
  const byType: Record<string, number> = {}
  for (const u of utterances) {
    const items = sanitizePiiLabels(u.pii_intervals)
    total += items.length
    for (const item of items) {
      const t = (item.piiType as string) ?? 'unknown'
      byType[t] = (byType[t] ?? 0) + 1
    }
  }
  return {
    summary: { total_pii_labels: total, utterance_count: utterances.length },
    distribution: { pii_type: byType },
    notes: [
      '안전선 #3: pii_intervals.original 외부 노출 금지. 본 리포트는 type/시간 구간 통계만.',
    ],
  }
}

// 패키지 루트 약관·라이선스 문서(플랫폼 상수). 세션별 증거는 metadata/consent_report.json.
const CONSENT_TERMS_AND_LICENSE_MD = `# Uncounted — Consent & Commercial License

## Consent Model: Two-Party Explicit Opt-In
이 데이터셋의 모든 녹음은 **양측 명시 opt-in** 동의로 수집되었습니다.
- 각 통화 참여자는 개별 토큰 초대를 받아 *각자* 명시적으로 동의함.
- 각 동의는 시각·IP·user-agent 감사기록과 함께 내부 보존됨.
- **양측이 모두 동의한 세션만**(consent_status = both_agreed) 포함됨.

세션별 동의 증거: metadata/consent_report.json

## 통상 소싱보다 강한 동의
광범위 ToS 수락·단측 동의·스크랩 소싱과 달리, 모든 발화가 **양측 명시 opt-in + 감사추적**을 갖습니다.

## Commercial Use & License
[법무 최종검토 보류] 본 데이터셋은 참여자가 동의 시점에 합의한 약관에 따라 제공됩니다.
플랫폼은 위 모델대로 동의가 취득되었음을 보증합니다.

⚠️ 상업적 AI 학습/파인튜닝/재판매 범위는 약관 문구의 최종 법무검토 대상입니다(추후 확정).

## Privacy
PII(이름·번호 등)는 텍스트([PII_*])와 오디오(beep)에서 마스킹됩니다.
동의자 감사데이터(IP/user-agent)는 본 외부 패키지에 포함되지 않습니다.
`

async function buildConsentReport(session: SessionRow): Promise<Record<string, unknown>> {
  const s = session as unknown as Record<string, unknown>
  // 양측 동의 audit(consent_invitations). ⚠️ ip_address/user_agent 는 동의자 PII →
  // 외부 ZIP 엔 *존재 여부*만(audit_present). 원문은 내부 보존(법적 증거).
  let parties: unknown[] = []
  try {
    const inv = await supabaseAdmin
      .from('consent_invitations')
      .select('role, status, responded_at, ip_address, user_agent')
      .eq('session_id', session.id)
    if (Array.isArray(inv.data)) {
      parties = inv.data.map((p) => {
        const r = p as Record<string, unknown>
        return {
          role: r.role ?? null,
          status: r.status ?? null,
          agreed_at: r.responded_at ?? null,
          audit_present: Boolean(r.ip_address || r.user_agent), // 원문 IP/UA 외부 미노출
        }
      })
    }
  } catch {
    /* invitations 미존재/FK 상이 → 세션레벨 증거만 */
  }
  return {
    session_id: session.id,
    consent_status: session.consent_status ?? null,
    consented_at: (s.consented_at as string | null) ?? null,
    consent_model: 'two_party_explicit_optin', // 양측 명시 opt-in(토큰 초대→각자 동의)
    review_status: session.review_status ?? null,
    session_dataset_eligible: session.session_dataset_eligible ?? null,
    parties, // 양측 audit (역할/동의시각/감사존재). 원문 IP/UA 외부 미노출(동의자 PII).
    terms_ref: 'CONSENT_TERMS_AND_LICENSE.md', // 약관·상업이용권리 = 루트 문서
    notes: [
      '양측 명시 opt-in + 감사추적(시각/IP/UA 내부보존). 단측·묵시 동의 아님.',
      '약관 전문·상업적 이용권리는 패키지 루트 CONSENT_TERMS_AND_LICENSE.md 참조.',
      '안전선 #5: both_agreed + approved 만 export.',
    ],
  }
}

function buildAudioManifest(
  utterances: UtteranceRow[],
  sessionId: string,
  audioExportMode: AudioExportMode,
): Record<string, unknown> {
  const embedded = audioExportMode === 'embedded'
  return {
    session_id: sessionId,
    audio_export_mode: audioExportMode,
    items: utterances.map((u) => ({
      utterance_id: u.id,
      start_sec: toNum(u.start_sec),
      end_sec: toNum(u.end_sec),
      duration_sec: toNum(u.duration_sec),
      // 외부 노출 금지: storage_path / s3_key / s3:// URI / bucket / signed URL.
      // builder 내부에서만 storage_path 로 S3 fetch. 외부엔 package-relative 참조만.
      audio_reference_id: `utt_${u.id}`,
      // embedded: ZIP 내부 경로. reference_only: 미동봉(null).
      zip_path: embedded ? `audio/${sessionId}/utt_${u.id}.wav` : null,
      segment_audio_included: embedded,
    })),
    notes: [
      '안전선 #8: 기본 audio_export_mode=reference_only.',
      'audio_reference_id 는 package-relative 참조. 내부 S3 키/URL 은 외부 ZIP 에 미포함.',
    ],
  }
}

function buildNumberPatternReport(utterances: UtteranceRow[]): Record<string, unknown> {
  const byType: Record<string, number> = {}
  let total = 0
  for (const u of utterances) {
    const items = sanitizeNumericPatterns(u.numeric_patterns)
    total += items.length
    for (const item of items) {
      const t = (item.type as string) ?? 'unknown'
      byType[t] = (byType[t] ?? 0) + 1
    }
  }
  return {
    summary: { total_numeric_patterns: total, utterance_count: utterances.length },
    distribution: { type: byType },
    notes: [
      '안전선 #4: surface_text / normalized 원문 외부 노출 금지. 마스킹 토큰만 포함.',
    ],
  }
}

function buildAudioMetadataReport(session: SessionRow): Record<string, unknown> {
  const meta = session.audio_metadata && typeof session.audio_metadata === 'object'
    ? (session.audio_metadata as Record<string, unknown>)
    : {}
  return {
    session_id: session.id,
    audio_metadata: meta,
    notes: [
      'session-level audio_metadata (074). 발화 라벨 라인에는 audio_metadata_ref 만 둔다.',
    ],
  }
}

function buildUtteranceFormReport(utterances: UtteranceRow[]): Record<string, unknown> {
  const utteranceTypeCounts: Record<string, number> = {}
  const turnTypeCounts: Record<string, number> = {}
  let shortResponse = 0
  let backchannel = 0
  let greeting = 0
  let closing = 0
  for (const u of utterances) {
    const f = u.utterance_form
    if (!f || typeof f !== 'object') continue
    const obj = f as Record<string, unknown>
    const ut = typeof obj.utterance_type === 'string' ? obj.utterance_type : 'unknown'
    const tt = typeof obj.turn_type === 'string' ? obj.turn_type : 'unknown'
    utteranceTypeCounts[ut] = (utteranceTypeCounts[ut] ?? 0) + 1
    turnTypeCounts[tt] = (turnTypeCounts[tt] ?? 0) + 1
    if (obj.is_short_response === true) shortResponse += 1
    if (obj.is_backchannel === true) backchannel += 1
    if (obj.is_greeting === true) greeting += 1
    if (obj.is_closing === true) closing += 1
  }
  return {
    summary: {
      utterance_count: utterances.length,
      short_response_count: shortResponse,
      backchannel_count: backchannel,
      greeting_count: greeting,
      closing_count: closing,
    },
    distribution: {
      utterance_type: utteranceTypeCounts,
      turn_type: turnTypeCounts,
    },
    notes: ['utterance_form 은 074 컬럼. 값이 없으면 미집계.'],
  }
}

function buildProcessingSummary(
  audioExportMode: AudioExportMode,
  includeAudio: boolean,
  includeRestricted: boolean,
): Record<string, unknown> {
  return {
    audio_export_mode: audioExportMode,
    include_audio: includeAudio,
    include_restricted: includeRestricted,
    generated_at: new Date().toISOString(),
    notes: [
      '안전선 #6: 모델명 직접 노출 금지. label_origin / label_version 은 외부 5종 allowlist.',
      '안전선 #8: include_audio=false 또는 audio_export_mode 미지정 시 reference_only.',
    ],
  }
}

// ── ZIP 조립 ─────────────────────────────────────────────────────────────

function assembleZip(stagingDir: string, zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 9 } })

    out.on('close', () => resolve())
    out.on('error', reject)
    archive.on('error', reject)
    archive.on('warning', (err: Error & { code?: string }) => {
      if (err.code === 'ENOENT') return
      reject(err)
    })

    archive.pipe(out)
    archive.directory(stagingDir, false)
    archive.finalize()
  })
}

// ── I/O 헬퍼 ─────────────────────────────────────────────────────────────

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
}

async function writeJsonl(filePath: string, lines: unknown[]): Promise<void> {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  await fs.writeFile(filePath, body, 'utf-8')
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, 'utf-8')
}

// ── 숫자 변환 ────────────────────────────────────────────────────────────

function toNum(value: unknown): number {
  const n = toNumOrNull(value)
  return n ?? 0
}

function toNumOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function round(value: number, digits: number): number {
  const m = Math.pow(10, digits)
  return Math.round(value * m) / m
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null
  const sum = values.reduce((a, b) => a + b, 0)
  return round(sum / values.length, 3)
}

function safeArrayLen(raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0
}

// ── 외부 안전선 요약 (참조용 export) ───────────────────────────────────────

export const EXPORT_V2_SAFETY_NOTES = [
  '#1 speaker_label allowlist: owner_candidate / counterparty_candidate / unknown',
  '#3 pii_intervals.original 외부 ZIP 미노출',
  '#4 numeric_patterns surface_text/normalized 원문 미노출 (masked 만)',
  '#6 모델명 / 학습 출처 / 내부 리포트 키워드 미노출',
  '#8 audio_export_mode 기본 reference_only',
] as const

// ── Test-only Exports ──────────────────────────────────────────────────
// export-builder.test.ts 에서 internal builder 함수를 직접 검증할 수 있도록 노출.
// 다른 위치에서 import 하지 말 것.
export const _testInternals = {
  buildAudioManifest,
  downloadAudioFilesToStaging,
  buildLabelLine,
  maskTextByPiiIntervals,
  buildCallTxt,
  buildUtteranceLine,
  buildCallJson,
  buildDatasetSummary,
  buildDatasetQualityReport,
  sanitizeVersionString,
  sanitizeModelVersions,
}
