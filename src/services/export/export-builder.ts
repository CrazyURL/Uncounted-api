/**
 * Export v2 — Layer 2 (단일 세션) ZIP 빌더.
 *
 * 기존 `lib/export/packageBuilder.ts` (BM v10.0/U-A01) 와 별도 경로.
 * v2 외부 ZIP 구조 + 안전선 13개 강제 + safety scan.
 *
 * Layer 1 (delivery_package.zip) / Layer 3 (batch_export.zip) 은 placeholder.
 */

import { createWriteStream, promises as fs } from 'fs'
import { randomBytes } from 'crypto'
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
} from '../../lib/export/transforms.js'
import {
  applySelfDeclaredGender,
  buildOwnerDemographics,
  buildSpeakerLookup,
  buildSpeakersSection,
  lookupRoleCandidate,
  type SelfDeclaredProfile,
  type SessionSpeakerRow,
  type SpeakerLookupMap,
  type SpeakerPersistentIdContext,
} from '../../lib/export/sessionSpeakers.js'
import { buildRelationFrequency } from '../../lib/export/relationGeneralization.js'
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
  // 화자 영속 가명 identity_key 소스 (counterparty 측). raw 미노출 — 해시 입력 전용.
  peer_id?: string | null
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
  // 세부감정(6대분류) — 헤드 학습 후 채워짐. emotion_category=분노/슬픔/불안/상처/당황/기쁨 텍스트.
  // null/미산출 시 auto_labels.emotion.sub=null (null-safe). DB 그대로(가공·정규화 X).
  emotion_category?: string | null
  emotion_category_confidence?: number | string | null
  // 주제(20분류) — 헤드 학습 후 채워짐. topic_category=가족/여행/건강… 텍스트. null=미산출.
  topic_category?: string | null
  topic_category_confidence?: number | string | null
  // 방언 권역 — 헤드 학습 후 채워짐. dialect=수도권/강원/충청… 텍스트. null=미산출.
  dialect?: string | null
  dialect_confidence?: number | string | null
  // V-A 차원감정 (074+ 신규 컬럼). null = 미산출. valence/arousal/dominance 실값(DB 그대로).
  emotion_valence?: number | string | null
  emotion_arousal?: number | string | null
  emotion_dominance?: number | string | null
  dialog_act?: string | null
  // 대화목적(speech_act) 백필 — heuristic_mvp 라벨. auto_labels.speech_act 소스.
  dialog_act_confidence?: number | string | null
  dialog_intensity?: number | null
  // 발화 단위 대화맥락 (turn_index/topic_thread/discourse_role/prev_turn_gist 4키 객체).
  // JSONB 그대로 통과 (이미 마스킹/fallback 처리된 객체). null = 미백필.
  conversation_context?: Record<string, unknown> | null
  label_source?: string | null
  label_confidence?: number | string | null
  auto_label_model_version?: string | null
  pii_intervals?: unknown
  speech_act_events?: unknown
  numeric_patterns?: unknown
  utterance_form?: Record<string, unknown> | null
  // Prosody/비유창성 메타 (DB utterances 실측 컬럼). null = 미산출. DB 그대로(숫자 메트릭, 모델명/PII 무관).
  //   silence_before_sec: 직전 발화와의 침묵 갭(초). 첫 발화는 null(이전 발화 없음).
  //   filler_word_count: 간투어(어/음/아) 수.
  //   speech_rate_wpm: 발화 속도(WPM).
  silence_before_sec?: number | string | null
  filler_word_count?: number | string | null
  speech_rate_wpm?: number | string | null
  // Task 5: 화자중첩(cross-talk) 메타. null = 미산출(평가 안 됨) → false 로 단정 금지.
  is_overlapping?: boolean | null
  overlap_count?: number | string | null
  overlap_total_sec?: number | string | null
  overlap_ratio?: number | string | null
  overlap_intervals?: unknown
  review_status?: string | null
  upload_status?: string | null
  // 세그먼트(주제 단위) FK. segments.jsonl 의 utterances 매칭 키 (session_segments.id).
  segment_id?: string | null
  [key: string]: unknown
}

// session_segments 행 (세그먼트 단위 주제 라벨). topic 의 정본은 세그먼트 단위.
interface SegmentRow {
  id: string
  session_id: string
  segment_index: number
  topic?: string | null
  start_ms?: number | null
  end_ms?: number | null
  topic_confidence?: number | null
  topic_method?: string | null
}

// segments.jsonl 의 session 당 1줄 객체 (packageBuilder.SegmentExportLine 미러).
interface SegmentExportLine {
  session_id: string
  segments: Array<{
    segment_id: string
    segment_index: number
    topic: string | null
    topic_confidence: number | null
    topic_method: string | null
    start_ms: number | null
    end_ms: number | null
    utterances: Array<{ utterance_id: string; speaker_role: string | null }>
  }>
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

  const { session, utterances: loadedUtterances, lineageRun, sessionSpeakers, relationFrequency, segments, selfDeclaredDemographics } =
    await loadSessionContext(sessionId)

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

  // 화자 영속 가명 컨텍스트(미역산 솔트해시). 동의(both_agreed) 세션만 salt 생성 → 미동의 시 가명 null.
  //   salt = export 1회당 랜덤(어디에도 저장 안 함 = 역산 불가). 단일 세션 경로라 세션당 1개.
  //   identity_key: owner=user_id, counterparty=peer_id (raw 미노출, 해시 입력 전용).
  const persistentIdCtx = buildPersistentIdContext(session)

  try {
    await writeAllArtifacts(stagingDir, {
      session,
      utterances,
      audioExportMode,
      includeAudio,
      includeRestricted,
      syncQualityReport,
      lineageRun,
      sessionSpeakers,
      relationFrequency,
      persistentIdCtx,
      segments,
      selfDeclaredDemographics,
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
  // 화자 메타(역할/성별/연령/관계). 없거나 조회 실패 시 빈 배열 — export 무중단.
  sessionSpeakers: SessionSpeakerRow[]
  // 관계(speaker_relation) K-익명성 게이트용 데이터셋 전체 빈도표. 조회 실패 시 빈 맵.
  relationFrequency: ReadonlyMap<string, number>
  // 세그먼트 단위 주제 라벨(session_segments). 없거나 조회 실패 시 빈 배열 — export 무중단.
  segments: SegmentRow[]
  // self(본인) 자기신고 demographics 블록(metadata/owner_demographics.json). 프로필부재 시 null.
  selfDeclaredDemographics: Record<string, unknown> | null
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

  // 화자 메타(session_speakers) — read-only. null-safe: 실패/부재 시 빈 배열, export 무중단.
  // speaker_relation 도 select 하나 외부 노출은 sessionSpeakers 모듈이 안전선 #4 로 게이트.
  let sessionSpeakers: SessionSpeakerRow[] = []
  try {
    const ss = await supabaseAdmin
      .from('session_speakers')
      .select(
        'speaker_label,speaker_role,speaker_role_source,speaker_gender,' +
          'speaker_voice_age_range,speaker_speech_age_range,speaker_relation,' +
          'speaker_identity_inference,speaker_gender_estimate,speaker_age_group_estimate',
      )
      .eq('session_id', sessionId)
    if (!ss.error && Array.isArray(ss.data)) {
      sessionSpeakers = ss.data as unknown as SessionSpeakerRow[]
    }
  } catch {
    // session_speakers optional — 미적용 환경에서도 export 정상
  }

  // ★관계 정본 = peer 단위(사용자×상대 1개). sessions.peer_id → peers.relationship 을
  //   counterparty(other) 화자의 speaker_relation 에 주입한다(cross-call 누적 관계).
  //   단일 통화에 관계 단서가 없어도 그 상대와의 누적 통화로 특정된 관계를 표시한다.
  //   peer 미확정(UNKNOWN/부재)이면 기존 per-call speaker_relation 보존(폴백). null-safe.
  try {
    const peerId =
      typeof session.peer_id === 'string' && session.peer_id.length > 0 ? session.peer_id : null
    if (peerId && sessionSpeakers.length > 0) {
      const pr = await supabaseAdmin
        .from('peers')
        .select('relationship')
        .eq('id', peerId)
        .maybeSingle()
      const rawRel = (pr.data as { relationship?: string | null } | null)?.relationship
      const peerRel =
        !pr.error && typeof rawRel === 'string' && rawRel.trim().length > 0 && rawRel !== 'UNKNOWN'
          ? rawRel.trim()
          : null
      if (peerRel !== null) {
        sessionSpeakers = sessionSpeakers.map((ss) =>
          ss.speaker_role === 'other' ? { ...ss, speaker_relation: peerRel } : ss,
        )
      }
    }
  } catch {
    // peer 관계 optional — 실패 시 per-call speaker_relation 그대로(무중단).
  }

  // ★self(본인) demographics = users_profile 자기신고값. 2갈래:
  //   (a) 성별: self 화자 gender_estimate override(librosa F0 phone-band 오판 역전, admin #85 정합).
  //       self 만 적용, other 화자는 librosa 모델값 보존.
  //   (b) 5종 블록(성별/실연령/지역/방언/언어): metadata/owner_demographics.json 으로 별도 동봉
  //       — per-speaker estimate(추정값)와 분리된 '자기신고' 출처. owner 본인 동의 데이터라
  //       K-게이트 비대상. PR-A 미스윕 경로(metadata/)라 fail-closed 위험 없음.
  //   null-safe: 실패/프로필부재면 무변경 + owner_demographics 미생성.
  let selfDeclaredDemographics: Record<string, unknown> | null = null
  try {
    const ownerId =
      typeof session.user_id === 'string' && session.user_id.length > 0 ? session.user_id : null
    if (ownerId) {
      const up = await supabaseAdmin
        .from('users_profile')
        .select('gender, age_band, region_group, accent_group, primary_language')
        .eq('user_id', ownerId)
        .maybeSingle()
      if (!up.error && up.data) {
        const profile = up.data as SelfDeclaredProfile
        sessionSpeakers = applySelfDeclaredGender(sessionSpeakers, profile.gender)
        selfDeclaredDemographics = buildOwnerDemographics(profile)
      }
    }
  } catch {
    // self 프로필 optional — 실패 시 librosa 그대로 + owner_demographics 미생성(무중단).
  }

  // 세그먼트 단위 주제 라벨(session_segments) — read-only. null-safe: 실패/부재 시 빈 배열.
  // topic 의 정본은 세그먼트 단위(발화 단위 헤드 미배선). segment_index 순 정렬.
  let segments: SegmentRow[] = []
  try {
    const seg = await supabaseAdmin
      .from('session_segments')
      .select('id, session_id, segment_index, topic, start_ms, end_ms, topic_confidence, topic_method')
      .eq('session_id', sessionId)
      .order('segment_index', { ascending: true })
    if (!seg.error && Array.isArray(seg.data)) {
      segments = seg.data as unknown as SegmentRow[]
    }
  } catch {
    // session_segments optional — 미적용 환경에서도 export 정상
  }

  // 관계 K-익명성(K=5) 게이트용 데이터셋 전체 빈도표 — read-only.
  // ★전체 테이블 집계라 PostgREST 1000행 cap 을 페이지네이션으로 넘긴다(단일 GET 시
  //   1000행으로 잘려 빈도가 왜곡 → 잘못된 게이트 판정). 실패 시 빈 맵(보수적 null-게이트).
  const relationFrequency = await loadRelationFrequency()

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
    return { session, utterances: outcome.kept, lineageRun, sessionSpeakers, relationFrequency, segments, selfDeclaredDemographics }
  }

  return { session, utterances: allUtterances, lineageRun, sessionSpeakers, relationFrequency, segments, selfDeclaredDemographics }
}

/**
 * 데이터셋 전체 session_speakers.speaker_relation 빈도표 로드 (K-익명성 게이트용).
 *
 * PostgREST 는 응답을 1000행으로 cap 하므로 .range() 페이지네이션으로 전 행을 순회한다.
 * (단일 select 시 1000행으로 잘려 관계 빈도가 과소집계 → 흔한값이 일반화/null 로
 *  오게이트될 수 있다.) 조회 실패/부분 실패 시 그때까지 수집분으로 집계(보수적).
 */
async function loadRelationFrequency(): Promise<ReadonlyMap<string, number>> {
  const PAGE = 1000
  const rows: Array<{ speaker_relation?: string | null }> = []
  try {
    for (let from = 0; ; from += PAGE) {
      const resp = await supabaseAdmin
        .from('session_speakers')
        .select('speaker_relation')
        .not('speaker_relation', 'is', null)
        .range(from, from + PAGE - 1)
      if (resp.error || !Array.isArray(resp.data)) break
      rows.push(...(resp.data as Array<{ speaker_relation?: string | null }>))
      if (resp.data.length < PAGE) break
    }
  } catch {
    // 빈도표 optional — 실패 시 그때까지 수집분(또는 빈 맵)으로 보수적 게이트.
  }
  return buildRelationFrequency(rows)
}

// ── 화자 영속 가명(미역산 솔트해시) ───────────────────────────────────────

/**
 * 화자 영속 가명 컨텍스트 산출. 디렉터 승인안(2026-06-06).
 *
 * - 동의 게이트: session.consent_status === 'both_agreed' 일 때만 salt 생성.
 *   (eligibility 게이트와 별개로 명시적 재확인 — includeRestricted 우회 시에도 미동의 가명 차단.)
 * - salt: crypto.randomBytes(16) hex. export 1회당 1개, *어디에도 저장 안 함*(역산 불가 핵심).
 * - identity_key: owner=user_id, counterparty=peer_id (raw — 해시 입력 전용, 외부 미노출).
 *   둘 다 없으면 해당 역할 화자 가명은 null.
 *
 * 미동의이면 salt=null → 전 화자 speaker_persistent_id=null.
 */
function buildPersistentIdContext(session: SessionRow): SpeakerPersistentIdContext {
  const consented = session.consent_status === 'both_agreed'
  const salt = consented ? randomBytes(16).toString('hex') : null
  const ownerKey = typeof session.user_id === 'string' && session.user_id.length > 0 ? session.user_id : null
  const peerKey = typeof session.peer_id === 'string' && session.peer_id.length > 0 ? session.peer_id : null
  return {
    salt,
    identityKeyByRole: {
      owner_candidate: ownerKey,
      counterparty_candidate: peerKey,
    },
  }
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
  /** 화자 메타(session_speakers). speaker_label 룩업 + call.json speakers[] 섹션 소스. */
  sessionSpeakers?: SessionSpeakerRow[]
  /** 관계 K-익명성(K=5) 게이트용 데이터셋 전체 빈도표. 미주입 시 빈 맵(보수적 게이트). */
  relationFrequency?: ReadonlyMap<string, number>
  /** 화자 영속 가명(미역산 솔트해시) 컨텍스트. 미동의/미주입 시 salt=null → 가명 null. */
  persistentIdCtx?: SpeakerPersistentIdContext | null
  /** 세그먼트 단위 주제 라벨(session_segments). 미주입/0개 시 segments.jsonl 미생성. */
  segments?: SegmentRow[]
  /** self(본인) 자기신고 demographics. 있으면 metadata/owner_demographics.json 동봉. */
  selfDeclaredDemographics?: Record<string, unknown> | null
}

async function writeAllArtifacts(
  stagingDir: string,
  ctx: WriteContext,
): Promise<void> {
  const { session, utterances, audioExportMode, includeAudio, includeRestricted } = ctx
  const lineageRun = ctx.lineageRun ?? null
  const sessionSpeakers = ctx.sessionSpeakers ?? []
  const relationFrequency = ctx.relationFrequency ?? new Map<string, number>()
  const persistentIdCtx = ctx.persistentIdCtx ?? null
  // speaker_label → 역할/성별/연령 룩업 (utterance/label 라인 배선용).
  const speakerLookup = buildSpeakerLookup(sessionSpeakers)
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
    buildCallJson(session, utterances, audioExportMode, lineageRun, sessionSpeakers, relationFrequency, persistentIdCtx),
  )
  await writeText(
    path.join(stagingDir, 'calls', `call_${sid}.txt`),
    buildCallTxt(utterances),
  )

  // utterances/ — JSON Schema 검증(하드게이트): 구조 위반 시 출하 차단.
  const utteranceLines = utterances.map((u) => buildUtteranceLine(u, sid, speakerLookup))
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
    utterances.map((u) => buildLabelLine(u, sid, audioExportMode, speakerLookup)),
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

  // metadata/owner_demographics.json — self(본인) 자기신고 demographics(성별/실연령/지역/방언/언어).
  // 프로필부재(null)면 파일 미생성 → 기존 ZIP 구조 불변. PR-A 스윕 비대상 경로(metadata/)라
  // 한국어 카테고리값(강원도/전라도 등)도 fail-closed 위험 없음.
  if (ctx.selfDeclaredDemographics) {
    await writeJson(path.join(metaDir, 'owner_demographics.json'), ctx.selfDeclaredDemographics)
  }

  // metadata/segments.jsonl — 세그먼트 단위 주제 라벨(topic 정본) + 화자 역할(packageBuilder 미러).
  // 세그먼트 0개(미산출/구세션)면 파일 미생성 → 기존 ZIP 구조 불변.
  const segmentLine = buildSegmentLine(session, ctx.segments ?? [], utterances, speakerLookup)
  if (segmentLine !== null) {
    await writeJsonl(path.join(metaDir, 'segments.jsonl'), [segmentLine])
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
    '- 화자 프로필(calls/call_*.json `speakers[]`): 성별/연령은 추정 객체(`*_estimate`)와',
    '  disclaimer 로만 노출됩니다 (확정 단정 금지).',
    '- `metadata/owner_demographics.json`: owner(본인) 화자의 *자기신고* demographics',
    '  (성별·연령대·지역·방언·언어)입니다. `speakers[].*_estimate`(모델 추정)와 달리 사용자가',
    '  직접 신고한 값으로 `source: self_declared` 로 표기됩니다. 프로필 미설정 시 파일이',
    '  생성되지 않습니다.',
    '- 관계(`relation_candidate`)는 K-익명성(K=5) 게이트 + 일반화 tier 로만 노출됩니다:',
    '  데이터셋 전체에서 흔한 관계(count>=5)는 원문, 희귀 관계는 상위 범주로 일반화,',
    '  일반화 후에도 희귀하면 노출하지 않습니다. 모두 추정값(disclaimer 동반)입니다.',
    '- `speakers[].speaker_persistent_id`: 미역산(irreversible) 솔트해시 가명입니다.',
    '  본 납품 데이터셋 *안에서만* 동일 인물의 cross-call 식별 용도이며, 제공자 내부',
    '  신원(원본 ID)으로의 역추적은 불가능합니다(솔트 미저장). 납품분 간/타 데이터셋과',
    '  교차 링크되지 않습니다. ⚠️ 재식별 시도 금지 — 동의(both_agreed) 세션만 부여되고,',
    '  신원 부재 또는 미동의 시 값은 null 입니다.',
    '- `auto_labels.emotion.sub`: 세부감정(6대분류: 분노/슬픔/불안/상처/당황/기쁨) 슬롯입니다.',
    '  미산출 시 null (자동 추정값).',
    '- `auto_labels.topic`: 주제(20분류: 가족/여행/건강/교육 등) 슬롯입니다 (자동 추정값).',
    '  미산출 시 null.',
    '- `auto_labels.dialect`: 방언 권역(수도권/강원/충청/전라/경북/경남/제주) 슬롯입니다 (자동 추정값).',
    '  미산출 시 null.',
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
  sessionSpeakers: SessionSpeakerRow[] = [],
  relationFrequency: ReadonlyMap<string, number> = new Map(),
  persistentIdCtx: SpeakerPersistentIdContext | null = null,
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
    // 화자 프로필 (session_speakers). 안전선 #1/#4/#6 준수:
    //   - 역할: predicted_role candidate 형 (self/other 단어 미노출)
    //   - 성별/연령: *_estimate 객체 + disclaimer (확정 단정 금지)
    //   - 관계(speaker_relation): K-익명성(K=5) 게이트 + 일반화 tier (SPEC §4.4 개정).
    //     흔한값(count>=5)→원문, 희귀값→일반화, tier 도 희귀/미지/부재→null.
    // 화자 메타 부재(미처리/IVR-only) 시 빈 배열 — 날조 금지.
    speakers: buildSpeakersSection(sessionSpeakers, relationFrequency, persistentIdCtx),
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

// transcript_text 에 char-level 로 이미 반영되는 CORE PII(파이프라인 PII_PATTERNS).
// 확장 candidate 타입(numeric_sensitive_like 등)은 transcript_text 에 char-마스킹되지 않으므로 별도 보강 대상.
const CORE_PII_TYPES: ReadonlySet<string> = new Set([
  '이름', '전화번호', '주민등록번호', '카드번호', '계좌번호', '이메일',
])

/**
 * 발화 텍스트를 PII 토큰으로 마스킹해 반환한다.
 *
 * 1순위: transcript_text 가 이미 [PII_*] 토큰으로 char-level 마스킹돼 있으면 그것을 정본으로 사용한다.
 *   - 파이프라인이 CORE PII(이름·전화·주민·카드·계좌·이메일)를 char 단위로 transcript_text 에 반영하므로 정밀하다.
 *   - word-시간겹침 재마스킹은 audio 구간폭(~1s)이 인접 word(~0.3s)를 싹쓸이해 과다마스킹/연속중복
 *     ([PII_이름] [PII_이름] …)을 유발하므로 회피한다(실단어 보존).
 *   - 단 transcript_text 가 char-마스킹하지 않는 '확장 candidate' 구간(numeric_sensitive_like 등)은
 *     해당 word 표면을 transcript_text 에서 토큰으로 치환해 보강한다(누출 방지).
 * 2순위(폴백): transcript_text 가 미마스킹이면 word-시간겹침으로 마스킹하되, 한 구간이 여러 word 에
 *   걸쳐 생기는 연속 동일 토큰은 1개로 병합한다.
 */
function maskTextByPiiIntervals(u: UtteranceRow): string {
  const text = typeof u.transcript_text === 'string' ? u.transcript_text : ''
  if (!text) return text
  const intervals = sanitizePiiLabels(u.pii_intervals)
  if (intervals.length === 0) return text
  const words = _coerceWords((u as Record<string, unknown>).transcript_words)

  // 1순위: 이미 char-마스킹된 정본 텍스트 사용 + 확장 candidate 구간 표면 보강.
  if (/\[PII_[^\]]+\]/.test(text) && words.length > 0) {
    let out = text
    for (const iv of intervals) {
      if (CORE_PII_TYPES.has(String(iv.piiType))) continue // CORE 는 transcript_text 에 이미 반영
      const s = iv.startSec as number
      const e = iv.endSec as number
      for (const w of words) {
        const surf = (w.word || '').trim()
        if (surf && w.start < e && w.end > s && out.includes(surf)) {
          out = out.split(surf).join(_piiToken(iv.piiType as string))
        }
      }
    }
    // 연속 동일 PII 토큰 병합 — 인접 word 가 각각 검출돼 char-마스킹된 중복([PII_이름] [PII_이름] …)을
    // 1개로 정리(뒤따르는 조사 접미는 보존). 누출과 무관한 표시 정리.
    out = out.replace(/(\[PII_[^\]]+\])(?:\s+\1)+/g, '$1')
    return out
  }

  if (words.length === 0) return text

  // 2순위(폴백): word-시간겹침 마스킹 + 연속 중복 토큰 병합.
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
  const deduped: string[] = []
  for (const tok of masked) {
    if (tok.startsWith('[PII_') && deduped.length > 0 && deduped[deduped.length - 1] === tok) continue
    deduped.push(tok)
  }
  const joined = deduped.join(' ').replace(/\s+/g, ' ').trim()
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

function buildUtteranceLine(
  u: UtteranceRow,
  sessionId: string,
  speakerLookup: SpeakerLookupMap = new Map(),
): Record<string, unknown> {
  return {
    utterance_id: u.id,
    session_id: sessionId,
    sequence_order: u.sequence_order,
    start_sec: toNum(u.start_sec),
    end_sec: toNum(u.end_sec),
    duration_sec: toNum(u.duration_sec),
    // speaker_label: 익명 diarization 라벨 (예: SPEAKER_00). 그대로 노출.
    speaker_label: typeof u.speaker_id === 'string' ? u.speaker_id : 'UNKNOWN',
    // speaker_role_candidate: session_speakers 룩업 → 안전선 #1 후보값만 (확정값 X).
    // 룩업 미스(IVR/미매핑) → unknown.
    speaker_role_candidate: lookupRoleCandidate(speakerLookup, u.speaker_id),
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
  speakerLookup: SpeakerLookupMap = new Map(),
): Record<string, unknown> {
  const piiLabels = sanitizePiiLabels(u.pii_intervals)
  const speechAct = buildSpeechAct(u)
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
    // session_speakers 룩업 → 안전선 #1 후보값. 룩업 미스(IVR/미매핑) → unknown.
    speaker_role_candidate: lookupRoleCandidate(speakerLookup, u.speaker_id),
    label_origin: sanitizeExternalLabelOrigin(u.label_source),
    label_version: sanitizeExternalMethod(u.auto_label_model_version),
    confidence_tier: tier.tier,
    label_confidence: labelConfidence,

    audio_export_mode: audioExportMode,
    audio_metadata_ref: sessionId,

    auto_labels: {
      emotion: buildAutoEmotion(u),
      speech_act: speechAct,
      // 주제(20분류)·방언(권역) 슬롯. 헤드 미학습 시 null (null-safe).
      topic: buildTopic(u),
      dialect: buildDialect(u),
    },

    utterance_form: u.utterance_form ?? null,
    numeric_patterns: numericPatterns,
    // 발화 단위 대화맥락 (turn_index/topic_thread/discourse_role/prev_turn_gist).
    // DB JSONB 그대로 통과 (이미 마스킹/fallback 처리됨). 미백필 시 null.
    conversation_context: u.conversation_context ?? null,
    emotion_detail: buildEmotionDetail(u),
    // Prosody/비유창성 메타 (침묵 갭 / 간투어 / 발화속도). DB 그대로, null-safe(개별 필드 결측 시 null).
    prosody: buildProsody(u),
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

/**
 * Prosody/비유창성 메타 객체 — DB utterances 실측 컬럼 묶음 노출.
 *
 * 바이어 요구 상호작용 라벨. 전부 숫자 메트릭(모델명/PII 무관, 안전선 무접촉).
 *   - silence_before_sec: 직전 발화와의 침묵 갭(초). 첫 발화는 DB null → null 그대로(0 으로 단정 금지).
 *   - filler_word_count: 간투어(어/음/아) 수.
 *   - speech_rate_wpm: 발화 속도(WPM).
 *
 * 값은 DB 그대로(가공 불요). 개별 필드 결측 시 해당 필드만 null (null-safe).
 * 세 필드 모두 결측이면 객체 자체를 null 반환 — 정직하게 null 노출.
 */
function buildProsody(u: UtteranceRow): Record<string, unknown> | null {
  const silenceBeforeSec = toNumOrNull(u.silence_before_sec)
  const fillerWordCount = toNumOrNull(u.filler_word_count)
  const speechRateWpm = toNumOrNull(u.speech_rate_wpm)
  if (silenceBeforeSec === null && fillerWordCount === null && speechRateWpm === null) {
    return null
  }
  return {
    silence_before_sec: silenceBeforeSec,
    filler_word_count: fillerWordCount,
    speech_rate_wpm: speechRateWpm,
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

/**
 * auto_labels.speech_act (대화목적) — dialog_act 백필 컬럼에서 생성.
 *
 * SPEC §4.2.13: speech_act_events → {value, confidence, method}. 단 현재 백필은
 * speech_act_events 가 비어 있고(JSONB []) dialog_act/dialog_act_confidence/label_source
 * flat 컬럼에 들어 있으므로 그쪽에서 직접 매핑한다.
 *
 * - value: u.dialog_act (15-class 한국어 라벨, 예 진술/질문 — 모델명 아님, 정상 노출).
 * - confidence: u.dialog_act_confidence (NUMERIC → number).
 * - method: 안전선 #6/#12 — label_source 를 외부 5종 allowlist 로 정직 일반화.
 *   현재 백필 source='heuristic_mvp' → 'heuristic_mvp' 노출 (supervised 위장 금지).
 *
 * dialog_act 미산출(null/empty)이면 null 반환 — 정직하게 null 노출.
 */
function buildSpeechAct(u: UtteranceRow): Record<string, unknown> | null {
  const value =
    typeof u.dialog_act === 'string' && u.dialog_act.length > 0 ? u.dialog_act : null
  if (value === null) return null
  return {
    value,
    confidence: toNumOrNull(u.dialog_act_confidence),
    method: sanitizeExternalMethod(u.label_source),
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
 * - sub: 세부감정(6대분류) 슬롯. emotion_category(분노/슬픔/불안/상처/당황/기쁨)+confidence.
 *   ★null-safe: emotion_category 미산출(현재 0%, 헤드 학습 후 채워짐)이면 sub=null.
 *   안전선 #6: 텍스트 라벨(모델명 아님)+숫자 confidence 만 — model_version 미노출.
 *
 * emotion 미산출(null/empty) 이면 null 반환 → 정직하게 null 노출.
 */
function buildAutoEmotion(u: UtteranceRow): Record<string, unknown> | null {
  const value = typeof u.emotion === 'string' && u.emotion.length > 0 ? u.emotion : null
  if (value === null) return null
  const subValue =
    typeof u.emotion_category === 'string' && u.emotion_category.length > 0
      ? u.emotion_category
      : null
  return {
    value,
    confidence: toNumOrNull(u.emotion_confidence),
    source: 'automatic',
    model_version: sanitizeExternalMethod(u.auto_label_model_version),
    // 세부감정 슬롯. 미산출 시 sub:null (부분 노출 오해 방지 — value 없으면 객체 자체 null).
    sub:
      subValue === null
        ? null
        : { value: subValue, confidence: toNumOrNull(u.emotion_category_confidence) },
  }
}

/**
 * 주제(topic) 자동 분류 라벨 — 20분류 헤드 산출. flat 컬럼 topic_category 기반.
 *
 * - value: u.topic_category (가족/여행/건강…). 미산출(null/empty)이면 객체 자체 null.
 * - confidence: u.topic_category_confidence (NUMERIC → number)
 * - source: 'automatic' — 자동 추정 marker.
 * ★null-safe: 헤드 미학습(현재 미산출)이면 null 반환 → 정직하게 null 노출.
 * 안전선 #6: 텍스트 라벨(모델명 아님)+숫자 confidence 만 노출.
 */
function buildTopic(u: UtteranceRow): Record<string, unknown> | null {
  const value =
    typeof u.topic_category === 'string' && u.topic_category.length > 0
      ? u.topic_category
      : null
  if (value === null) return null
  return {
    value,
    confidence: toNumOrNull(u.topic_category_confidence),
    source: 'automatic',
  }
}

/**
 * 방언 권역(dialect) 자동 분류 라벨 — 권역 헤드 산출. flat 컬럼 dialect 기반.
 *
 * - value: u.dialect (수도권/강원/충청…). 미산출이면 객체 자체 null.
 * - confidence: u.dialect_confidence (NUMERIC → number)
 * - source: 'automatic'.
 * ★null-safe: 헤드 미학습이면 null. 안전선 #6: 텍스트 라벨+숫자만.
 */
function buildDialect(u: UtteranceRow): Record<string, unknown> | null {
  const value = typeof u.dialect === 'string' && u.dialect.length > 0 ? u.dialect : null
  if (value === null) return null
  return {
    value,
    confidence: toNumOrNull(u.dialect_confidence),
    source: 'automatic',
  }
}

/**
 * V-A 차원감정 상세 (emotion_detail). auto_labels.emotion(요약값)의 "상세판" 슬롯.
 *
 * flat 컬럼 emotion_valence / emotion_arousal / emotion_dominance 에서 직접 매핑.
 * 세 값이 모두 존재(숫자 변환 성공)할 때만 객체 반환, 하나라도 결측이면 null
 * (부분 노출로 인한 오해 방지 — 차원감정은 3축이 함께여야 의미).
 *
 * - valence/arousal/dominance: DB 값 그대로 (변환·정규화 X).
 * - method: 안전선 #6 — raw 모델명(audeering/wav2vec 등) 절대 노출 금지.
 *   전용 모델버전 컬럼이 없으므로 'automatic' 으로 일반화 노출.
 */
function buildEmotionDetail(u: UtteranceRow): Record<string, unknown> | null {
  const valence = toNumOrNull(u.emotion_valence)
  const arousal = toNumOrNull(u.emotion_arousal)
  const dominance = toNumOrNull(u.emotion_dominance)
  if (valence === null || arousal === null || dominance === null) return null
  return {
    valence,
    arousal,
    dominance,
    // 안전선 #6: 모델명 비노출. V-A 회귀모델 → 일반화 method 카테고리.
    method: sanitizeExternalMethod('automatic'),
  }
}

// ── segments (세그먼트 단위 주제) ─────────────────────────────────────────

/**
 * metadata/segments.jsonl 의 session 당 1줄 객체 구성 (packageBuilder STAGE 16 미러).
 *
 * session_segments(주제 정본) 를 segment_index 순으로 펼치고, 각 세그먼트에 그 세그먼트에
 * 속한 발화(utterances.segment_id === session_segments.id)의 utterance_id + speaker_role 을 붙인다.
 *
 * - topic: 텍스트 라벨(가족/여행/교통…). null-safe.
 * - topic_method: "model"/"keyword" — 산출방식 enum. 안전선 #6: 모델명 아님(안전).
 * - speaker_role: export-builder 표준대로 session_speakers 룩업 후보값(lookupRoleCandidate).
 *   utterances 에 raw speaker_role 컬럼이 없으므로 speaker_label 룩업으로 도출(안전선 #1 후보형).
 *
 * 세그먼트 0개면 null 반환 → 호출부에서 파일 미생성.
 */
function buildSegmentLine(
  session: SessionRow,
  segments: SegmentRow[],
  utterances: UtteranceRow[],
  speakerLookup: SpeakerLookupMap,
): SegmentExportLine | null {
  if (!Array.isArray(segments) || segments.length === 0) return null
  const line: SegmentExportLine = { session_id: session.id, segments: [] }
  for (const seg of segments) {
    const segUtterances = utterances
      .filter((u) => u.segment_id === seg.id)
      .map((u) => ({
        utterance_id: u.id,
        speaker_role: lookupRoleCandidate(speakerLookup, u.speaker_id),
      }))
    line.segments.push({
      segment_id: seg.id,
      segment_index: seg.segment_index,
      topic: seg.topic ?? null,
      // 주제 신뢰도 + 산출방식("model"=학습분류기 / "keyword"=fallback). 안전선 #6: 모델명 아님.
      topic_confidence: toNumOrNull(seg.topic_confidence),
      topic_method: seg.topic_method ?? null,
      start_ms: toNumOrNull(seg.start_ms),
      end_ms: toNumOrNull(seg.end_ms),
      utterances: segUtterances,
    })
  }
  return line
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
  buildEmotionDetail,
  buildProsody,
  maskTextByPiiIntervals,
  buildCallTxt,
  buildUtteranceLine,
  buildCallJson,
  buildDatasetSummary,
  buildDatasetQualityReport,
  buildSegmentLine,
  sanitizeVersionString,
  sanitizeModelVersions,
}
