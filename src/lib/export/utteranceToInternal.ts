/**
 * UtteranceRow → adapter 입력 매핑 (D1).
 *
 * export-builder 의 DB 행(UtteranceRow)을 두 가지 어댑터 입력으로 변환한다:
 *   1. InternalUtterance      — baselineAdapter(D6) 의 canonical 입력
 *   2. UtteranceSyncInput     — Sync Integrity Gate(D1) 의 정합 검사 입력
 *
 * ⚠️ role 출처: 기존 export-builder 가 `speaker_id` 하나를 speaker_label·role 양쪽에
 *    쓰던 것을 그대로 미러한다(`raw_speaker_role = speaker_id`). 게이트 off 시 출력은
 *    기존과 동일. DB 에 전용 role 컬럼이 생기면 후속 PR 에서 출처를 분리한다.
 *    (anchor-user-relative 의미는 baselineAdapter 주석 참조 — consent/call-direction 축 아님.)
 */

import type { InternalUtterance } from './baselineAdapter.js'
import type { PiiInterval, UtteranceSyncInput } from './syncIntegrityGate.js'

/** export-builder UtteranceRow 중 매핑에 필요한 최소 부분집합. */
export interface UtteranceRowLike {
  id: string
  sequence_order: number
  speaker_id?: string | null
  start_sec: number | string
  end_sec: number | string
  duration_sec?: number | string | null
  storage_path?: string | null
  transcript_text?: string | null
  label_source?: string | null
  auto_label_model_version?: string | null
  dialog_act?: string | null
  dialog_act_group?: string | null
  pii_intervals?: unknown
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

function toNum(value: unknown): number {
  return toNumOrNull(value) ?? 0
}

function speakerLabelOf(u: UtteranceRowLike): string {
  return typeof u.speaker_id === 'string' && u.speaker_id.length > 0 ? u.speaker_id : 'UNKNOWN'
}

/**
 * UtteranceRow → InternalUtterance (baselineAdapter canonical 입력).
 * 정규화는 어댑터가 수행하므로 여기선 원시값 전달만(speaker_label/role 분리 포함).
 */
export function mapUtteranceRowToInternal(
  u: UtteranceRowLike,
  sessionId: string,
): InternalUtterance {
  return {
    id: u.id,
    session_id: sessionId,
    sequence_order: u.sequence_order,
    speaker_label: typeof u.speaker_id === 'string' ? u.speaker_id : null,
    // 기존 conflation 미러: role 출처 = speaker_id (게이트 off 시 출력 불변).
    raw_speaker_role: typeof u.speaker_id === 'string' ? u.speaker_id : null,
    start_sec: u.start_sec,
    end_sec: u.end_sec,
    text_masked: typeof u.transcript_text === 'string' ? u.transcript_text : null,
    label_source: u.label_source ?? null,
    auto_label_model_version: u.auto_label_model_version ?? null,
    dialog_act: u.dialog_act ?? null,
    dialog_act_group: u.dialog_act_group ?? null,
  }
}

/** pii_intervals(JSONB) → 시간 구간 배열. start/end 키 변형(snake/camel) 모두 수용. */
function parsePiiIntervals(raw: unknown): PiiInterval[] {
  if (!Array.isArray(raw)) return []
  const out: PiiInterval[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const start = toNumOrNull(obj.start_sec ?? obj.startSec)
    const end = toNumOrNull(obj.end_sec ?? obj.endSec)
    if (start === null || end === null) continue
    out.push({ start_sec: start, end_sec: end })
  }
  return out
}

/** UtteranceRow → Sync Integrity Gate 입력(정합 검사용; 텍스트 원문 미포함). */
export function mapUtteranceRowToSyncInput(u: UtteranceRowLike): UtteranceSyncInput {
  const transcript = typeof u.transcript_text === 'string' ? u.transcript_text : ''
  return {
    utterance_id: u.id,
    start_sec: toNum(u.start_sec),
    end_sec: toNum(u.end_sec),
    duration_sec: toNumOrNull(u.duration_sec),
    has_transcript: transcript.trim().length > 0,
    has_audio_ref: typeof u.storage_path === 'string' && u.storage_path.length > 0,
    speaker_label: speakerLabelOf(u),
    pii_intervals: parsePiiIntervals(u.pii_intervals),
  }
}
