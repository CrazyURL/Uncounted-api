// PR-P2A-1: 확정 PII 라벨(pii_annotations) 등록용 순수 헬퍼.
//
// 책임(모두 부수효과 없는 순수/결정적 함수 — 단위 테스트 대상):
//   1) enum 검증 — source / pii_type / action_status 허용값 검증.
//   2) span 추출 — transcript_text + offset 로 PII 구간 substring 산출(경계 방어).
//   3) hash — NFC 정규화 후 sha256 hex(단방향). 원문은 저장/반환하지 않는다.
//   4) insert 행 생성 — admin_manual 등록 행(immutable) 빌드.
//
// 안전 계약: 본 모듈은 입력 transcript / span 원문을 어디에도 로깅/저장하지 않는다.
// 추출한 span 은 hash 산출 후 폐기되며, insert 행에는 normalized_text_hash 만 들어간다(원문 없음).
//
// 설계: scripts/analysis/design_pii_annotation_learning_loop_20260524.md

import { createHash } from 'node:crypto'

// ── enum 허용값 (migration 078 CHECK 와 일치) ───────────────────────
export const VALID_SOURCES = ['detector_candidate', 'admin_manual', 'denylist', 'regex'] as const
export type AnnotationSource = (typeof VALID_SOURCES)[number]

export const VALID_PII_TYPES = [
  'name',
  'phone',
  'account',
  'address',
  'ip',
  'email',
  'organization',
  'resident_id',
  'other',
] as const
export type PiiType = (typeof VALID_PII_TYPES)[number]

export const VALID_ACTION_STATUSES = ['pending_mask', 'masked', 'excluded', 'revoked'] as const
export type ActionStatus = (typeof VALID_ACTION_STATUSES)[number]

export function isValidSource(v: unknown): v is AnnotationSource {
  return typeof v === 'string' && (VALID_SOURCES as readonly string[]).includes(v)
}

export function isValidPiiType(v: unknown): v is PiiType {
  return typeof v === 'string' && (VALID_PII_TYPES as readonly string[]).includes(v)
}

export function isValidActionStatus(v: unknown): v is ActionStatus {
  return typeof v === 'string' && (VALID_ACTION_STATUSES as readonly string[]).includes(v)
}

// ── span 추출 ────────────────────────────────────────────────────────
/**
 * transcript_text[charStart..charEnd] 를 추출한다. hash 산출 용도이며 저장/반환하지 않는다.
 *
 * 방어적 처리(buildSnippet 과 동일 규약):
 *   - text 가 비었거나, offset 이 number 가 아니거나, 클램프 후 start>=end 면 null.
 *   - offset 은 [0, text.length] 로 클램프.
 *
 * 한글은 BMP(서로게이트 페어 없음)라 Python code point offset == JS UTF-16 슬라이스가 일치한다.
 */
export function extractSpan(
  text: string | null | undefined,
  charStart: number | null | undefined,
  charEnd: number | null | undefined,
): string | null {
  if (!text || typeof charStart !== 'number' || typeof charEnd !== 'number') {
    return null
  }
  const start = Math.max(0, Math.min(charStart, text.length))
  const end = Math.max(0, Math.min(charEnd, text.length))
  if (start >= end) {
    return null
  }
  return text.slice(start, end)
}

// ── hash ─────────────────────────────────────────────────────────────
/** NFC 정규화 + 양끝 공백 제거. denylist 매칭/중복 판정 일관성용. */
export function normalizeForHash(text: string): string {
  return text.normalize('NFC').trim()
}

/**
 * 정규화 후 sha256 hex. 단방향(원문 복원 불가). 빈 정규화 결과는 null.
 * 같은 입력 → 같은 hash(결정적) → dedup/denylist 매칭 가능.
 */
export function hashNormalized(text: string | null | undefined): string | null {
  if (!text) {
    return null
  }
  const normalized = normalizeForHash(text)
  if (normalized.length === 0) {
    return null
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

// ── insert 행 생성 ───────────────────────────────────────────────────
export interface ManualAnnotationParams {
  utteranceId: string
  sessionId: string
  piiType: PiiType
  charStart: number | null
  charEnd: number | null
  normalizedTextHash: string | null
  reviewedBy: string
  note: string | null
}

export interface AnnotationInsertRow {
  utterance_id: string
  session_id: string
  source: 'admin_manual'
  candidate_id: null
  pii_type: PiiType
  char_start: number | null
  char_end: number | null
  normalized_text_hash: string | null
  action_status: 'pending_mask'
  reviewed_by: string
  reviewed_at: string
  note: string | null
}

/**
 * admin_manual 등록 행(immutable) 빌드. candidate_id 는 항상 null(승격은 PR-P2A-2).
 * 원문 텍스트 필드는 의도적으로 존재하지 않는다 — normalized_text_hash 만 보존.
 */
export function buildManualAnnotationInsert(
  params: ManualAnnotationParams,
  reviewedAt: string,
): AnnotationInsertRow {
  return {
    utterance_id: params.utteranceId,
    session_id: params.sessionId,
    source: 'admin_manual',
    candidate_id: null,
    pii_type: params.piiType,
    char_start: params.charStart,
    char_end: params.charEnd,
    normalized_text_hash: params.normalizedTextHash,
    action_status: 'pending_mask',
    reviewed_by: params.reviewedBy,
    reviewed_at: reviewedAt,
    note: params.note,
  }
}
