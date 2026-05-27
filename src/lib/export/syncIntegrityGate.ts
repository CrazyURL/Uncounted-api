/**
 * Sync Integrity Gate (D1) — utterance audio-text pair 의 **export 전 참조무결성 검증**.
 *
 * 최상위 납품 게이트. "audio ↔ transcript ↔ timing ↔ pii_interval 정합이 깨진
 * 어떤 export 산출물도 fail-closed 로 차단하고 패키지에 포함하지 않는다."
 * (과거 audio-text sync mismatch 로 데이터가 무용지물이 된 교훈.)
 *
 * 본 모듈은 D6 `baselineAdapter.runSyncIntegrityGate()`(no-arg STUB)가 자리만
 * 잡아둔 8개 체크를 **발화 단위 실검증**으로 구현한다(D6 stub 은 package-level
 * placeholder 로 그대로 유지). 검증 실패 발화는 **제외**(fail-closed)하며,
 * **timing(start/end)을 사후 보정하지 않는다** — 깨진 발화는 고치지 않고 뺀다.
 *
 * ── D1 범위 ────────────────────────────────────────────────────────────────
 *   - metadata-level 참조 정합만 검사(DB 필드 기반). **WAV 디코딩/ffprobe/음향분석 없음.**
 *   - 6개 체크 실구현 + `mask_in_bounds` 는 not_implemented(D5 acoustic masking 의존).
 *   - 실제 오디오 길이 대조(ASR/probe)는 후속 과제 — D1 은 metadata 자기정합까지.
 *
 * ── 범위 밖(금지) ───────────────────────────────────────────────────────────
 *   D2 overlap / D3 confidence 산식 / D4 pii_intervals emit / D5 acoustic masking /
 *   timing 사후 보정 / safety gate 완화.
 *   (pii_in_bounds 는 **기존 pii_intervals 데이터의 구간 검증**이며 D4 emit 구현이 아니다.)
 */

import type {
  SyncIntegrityCheck,
  SyncIntegrityCheckName,
  SyncIntegrityResult,
} from './baselineAdapter.js'
import type { AudioExportMode } from '../../services/export/export-types.js'

/** masking 구간 정합 검사 기본 허용오차(초). 설계문 20~50ms 중 D1 은 느슨한 50ms. */
export const DEFAULT_DURATION_TOLERANCE_SEC = 0.05

// ── 입력 계약 ───────────────────────────────────────────────────────────────

export interface PiiInterval {
  start_sec: number
  end_sec: number
}

/**
 * 게이트가 소비하는 발화 1건의 정합 검사 입력(DB 필드에서 매핑).
 * 텍스트 원문/PII 원문은 담지 않는다(존재 여부 boolean + 시간 구간만).
 */
export interface UtteranceSyncInput {
  utterance_id: string
  start_sec: number
  end_sec: number
  duration_sec: number | null
  /** transcript_text(마스킹된 텍스트) 가 비어있지 않은가 = pair 의 텍스트 절반 존재. */
  has_transcript: boolean
  /** storage_path 보유 = pair 의 오디오 절반(embedded WAV) 존재 가능. */
  has_audio_ref: boolean
  /** 익명 diarization 라벨(예: SPEAKER_00) 또는 'UNKNOWN'. */
  speaker_label: string
  /** 기존 pii_intervals(시간 구간만). 비어있을 수 있음(§5: 현재 대부분 미emit). */
  pii_intervals: PiiInterval[]
}

export interface SyncIntegrityContext {
  audioExportMode: AudioExportMode
  /** 기본 DEFAULT_DURATION_TOLERANCE_SEC. */
  durationToleranceSec?: number
}

// ── 단일 발화 게이트 ─────────────────────────────────────────────────────────

const ALL_CHECK_NAMES: readonly SyncIntegrityCheckName[] = [
  'duration_match',
  'pii_in_bounds',
  'mask_in_bounds',
  'transcript_audio_align',
  'utterance_id_file_match',
  'speaker_id_in_profile',
  'timeline_post_clip_match',
  'metadata_audio_pairing',
]

function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/** not_implemented 체크는 게이트를 막지 않는다(na 취급). */
function isBlocking(c: SyncIntegrityCheck): boolean {
  return !c.ok && !c.detail.startsWith('not_implemented')
}

/**
 * 발화 1건의 Sync Integrity 검사.
 *
 * 집계 규칙: `ok = checks 가 모두 (ok || not_implemented)` —
 * not_implemented 체크는 차단하지 않는다(na). 실패한 실구현 체크가 1개라도 있으면 ok=false.
 *
 * ⚠️ 어떤 체크도 start_sec/end_sec/duration 을 수정하지 않는다(검증 전용).
 */
export function checkUtteranceSyncIntegrity(
  input: UtteranceSyncInput,
  ctx: SyncIntegrityContext,
): SyncIntegrityResult {
  const tol = ctx.durationToleranceSec ?? DEFAULT_DURATION_TOLERANCE_SEC
  const { start_sec, end_sec, duration_sec } = input
  const clipLen = end_sec - start_sec
  const checks: SyncIntegrityCheck[] = []

  // 1. timeline_post_clip_match — clip-local timeline 정상성(유한·비음수·순서).
  const timelineOk = isFiniteNum(start_sec) && isFiniteNum(end_sec) && start_sec >= 0 && end_sec > start_sec
  checks.push({
    name: 'timeline_post_clip_match',
    ok: timelineOk,
    detail: timelineOk ? 'ok' : `invalid timeline (start=${start_sec}, end=${end_sec})`,
  })

  // 2. duration_match — |(end-start) - duration_sec| <= tol. duration_sec 부재면 na.
  if (duration_sec === null) {
    checks.push({ name: 'duration_match', ok: true, detail: 'na: duration_sec absent' })
  } else if (!timelineOk || !isFiniteNum(duration_sec)) {
    checks.push({ name: 'duration_match', ok: false, detail: 'non-finite duration/timeline' })
  } else {
    const drift = Math.abs(clipLen - duration_sec)
    checks.push({
      name: 'duration_match',
      ok: drift <= tol,
      detail: drift <= tol ? `ok (drift=${round(drift)}s)` : `drift ${round(drift)}s > tol ${tol}s`,
    })
  }

  // 3. transcript_audio_align — pair 의 텍스트 절반 존재(마스킹된 transcript 비어있지 않음).
  checks.push({
    name: 'transcript_audio_align',
    ok: input.has_transcript,
    detail: input.has_transcript ? 'ok: transcript present' : 'transcript missing/empty',
  })

  // 4. utterance_id_file_match — embedded 모드면 WAV 동봉 가능해야(storage_path 존재).
  if (ctx.audioExportMode === 'embedded') {
    checks.push({
      name: 'utterance_id_file_match',
      ok: input.has_audio_ref,
      detail: input.has_audio_ref ? 'ok: audio ref present' : 'embedded mode but no audio ref (broken pair)',
    })
  } else {
    checks.push({
      name: 'utterance_id_file_match',
      ok: true,
      detail: 'na: reference_only (no embedded WAV expected)',
    })
  }

  // 5. speaker_id_in_profile — 익명 화자 라벨 존재(빈 문자열 아님). 'UNKNOWN' 은 정당값.
  const speakerOk = typeof input.speaker_label === 'string' && input.speaker_label.length > 0
  checks.push({
    name: 'speaker_id_in_profile',
    ok: speakerOk,
    detail: speakerOk ? 'ok' : 'speaker_label empty',
  })

  // 6. pii_in_bounds — 기존 pii 구간이 유한·정렬·clip 길이 내. (절대/clip-local 출처는
  //    D4 확정 전까지 단정하지 않으므로 길이 상한만 검사 → 과다 제외 방지.)
  const piiResult = checkPiiInBounds(input.pii_intervals, clipLen, tol, timelineOk)
  checks.push({ name: 'pii_in_bounds', ok: piiResult.ok, detail: piiResult.detail })

  // 7. metadata_audio_pairing — audio_manifest 항목 well-formedness(timing 유한·정렬).
  const metaOk =
    isFiniteNum(start_sec) &&
    isFiniteNum(end_sec) &&
    end_sec >= start_sec &&
    (duration_sec === null || isFiniteNum(duration_sec))
  checks.push({
    name: 'metadata_audio_pairing',
    ok: metaOk,
    detail: metaOk ? 'ok' : 'manifest timing not well-formed',
  })

  // 8. mask_in_bounds — D5 acoustic masking 의존. D1 미구현.
  checks.push({ name: 'mask_in_bounds', ok: true, detail: 'not_implemented (D5)' })

  // 안정적 순서로 정렬(8개 고정 순서).
  checks.sort((a, b) => ALL_CHECK_NAMES.indexOf(a.name) - ALL_CHECK_NAMES.indexOf(b.name))

  const ok = checks.every((c) => !isBlocking(c))
  return { ok, checks }
}

function checkPiiInBounds(
  intervals: PiiInterval[],
  clipLen: number,
  tol: number,
  timelineOk: boolean,
): { ok: boolean; detail: string } {
  if (!Array.isArray(intervals) || intervals.length === 0) {
    return { ok: true, detail: 'ok: no pii intervals' }
  }
  if (!timelineOk) {
    return { ok: false, detail: 'pii present but utterance timeline invalid' }
  }
  for (const iv of intervals) {
    const s = iv?.start_sec
    const e = iv?.end_sec
    if (!isFiniteNum(s) || !isFiniteNum(e) || s < 0 || e < s) {
      return { ok: false, detail: 'pii interval malformed (non-finite/negative/inverted)' }
    }
    if (e - s > clipLen + tol) {
      return { ok: false, detail: `pii interval longer than clip (${round(e - s)}s > ${round(clipLen)}s)` }
    }
  }
  return { ok: true, detail: `ok: ${intervals.length} interval(s) in bounds` }
}

// ── 배치 게이트 + sync_quality_report ────────────────────────────────────────

export interface SyncExclusion {
  utterance_id: string
  failed_checks: SyncIntegrityCheckName[]
}

export type CheckDistribution = Record<
  SyncIntegrityCheckName,
  { ok: number; fail: number; not_implemented: number }
>

/**
 * sync_quality_report.json 페이로드.
 * ⚠️ 텍스트/PII 원문/화자 식별정보 없음(utterance_id 만). ops 용 리포트.
 */
export interface SyncQualityReport {
  gate: 'sync_integrity'
  audio_export_mode: AudioExportMode
  tolerance_sec: number
  kept_count: number
  excluded_count: number
  excluded: SyncExclusion[]
  check_distribution: CheckDistribution
  notes: string[]
}

export interface SyncGateOutcome {
  kept: UtteranceSyncInput[]
  excluded: SyncExclusion[]
  report: SyncQualityReport
}

function emptyDistribution(): CheckDistribution {
  const d = {} as CheckDistribution
  for (const name of ALL_CHECK_NAMES) d[name] = { ok: 0, fail: 0, not_implemented: 0 }
  return d
}

/**
 * 발화 배열에 게이트 적용 → kept/excluded partition + sync_quality_report.
 * 실패 발화는 제외(fail-closed). 전부 제외돼도 빈 집합으로 진행(임계값 게이트 없음).
 */
export function applySyncIntegrityGate(
  inputs: UtteranceSyncInput[],
  ctx: SyncIntegrityContext,
): SyncGateOutcome {
  const tol = ctx.durationToleranceSec ?? DEFAULT_DURATION_TOLERANCE_SEC
  const kept: UtteranceSyncInput[] = []
  const excluded: SyncExclusion[] = []
  const dist = emptyDistribution()

  for (const input of inputs) {
    const result = checkUtteranceSyncIntegrity(input, ctx)
    const failed: SyncIntegrityCheckName[] = []
    for (const c of result.checks) {
      const bucket = dist[c.name]
      if (c.detail.startsWith('not_implemented')) {
        bucket.not_implemented += 1
      } else if (c.ok) {
        bucket.ok += 1
      } else {
        bucket.fail += 1
        failed.push(c.name)
      }
    }
    if (result.ok) {
      kept.push(input)
    } else {
      excluded.push({ utterance_id: input.utterance_id, failed_checks: failed })
    }
  }

  const report: SyncQualityReport = {
    gate: 'sync_integrity',
    audio_export_mode: ctx.audioExportMode,
    tolerance_sec: tol,
    kept_count: kept.length,
    excluded_count: excluded.length,
    excluded,
    check_distribution: dist,
    notes: [
      '최상위 납품 게이트: audio↔transcript↔timing↔pii 정합 실패 발화는 fail-closed 제외.',
      'metadata-level 자기정합만 검사(D1). 실제 WAV 길이 대조/음향 마스킹 정합은 후속(D5).',
      'timing(start/end)은 보정하지 않음 — 깨진 발화는 제외만.',
    ],
  }

  return { kept, excluded, report }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
