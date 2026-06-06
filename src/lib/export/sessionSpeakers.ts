/**
 * session_speakers → 외부 export 변환.
 *
 * DB `session_speakers` 테이블에는 화자별 역할/성별/연령/관계가 계산돼 있으나
 * export-builder 가 이를 읽지 않아 deliverable 에 화자 정보가 누락돼 있었다.
 * 본 모듈은 (1) speaker_label → 룩업맵 생성, (2) call.json `speakers[]` 섹션
 * 객체 생성을 담당한다. export 는 DB read-only — write 0.
 *
 * 안전선 (SPEC_EXPORT_V2 §1, §4.4):
 *   - #1: self/other 확정 단어 절대 외부 노출 X.
 *         speaker_role → owner_candidate/counterparty_candidate/unknown (candidate 형).
 *         gender/voice_age 는 확정 단어가 아닌 `*_estimate` 객체 + disclaimer 로 노출.
 *   - #4: speaker_relation(부모/배우자/교사 등 관계)은 관계 PII → K-익명성(K=5) 게이트
 *         + 일반화 tier 로만 노출(quasi-identifier 통제). SPEC §4.4 개정(2026-06-05).
 *         흔한값(count>=5)은 원문, 희귀값은 일반화 tier, tier 도 희귀면 null.
 *   - #6: 내부 모델명/버전은 method 일반화(sanitizeExternalMethod) 후에만 노출.
 */

import { createHash } from 'crypto'

import {
  mapSessionSpeakerRoleToCandidate,
  sanitizeExternalMethod,
  type ExternalSpeakerRole,
} from './transforms.js'
import { resolveRelationCandidate } from './relationGeneralization.js'

/**
 * 관계(speaker_relation) 외부 노출 토글.
 *
 * ★true (2026-06-05 디렉터 승인) — SPEC §4.4 개정으로 "노출 금지 확정"이 폐기되고
 * "K-익명성(K=5) 게이트 + 일반화 tier" 로 안전 노출한다. 노출 형태는 candidate/
 * disclaimer 톤(`speakers[].relation_candidate`)이며, 데이터셋 전체 빈도표 기준으로
 * 흔한값(count>=5)만 원문·희귀값은 일반화·tier 도 희귀면 null 로 게이트된다.
 * (self/other 단어·모델명 노출 금지(#1/#6)는 그대로 유지.)
 */
export const EXPOSE_SPEAKER_RELATION = true

const SPEAKER_INFERENCE_DISCLAIMER =
  'Probabilistic inference only. Not a verified identity.'
const SPEAKER_ESTIMATE_DISCLAIMER = 'Estimated attribute, not verified identity.'

// ── DB 행 타입 (필요한 컬럼만) ────────────────────────────────────────────

export interface SessionSpeakerRow {
  speaker_label?: string | null
  speaker_role?: string | null
  speaker_role_source?: string | null
  speaker_gender?: string | null
  speaker_voice_age_range?: string | null
  speaker_speech_age_range?: string | null
  speaker_relation?: string | null
  speaker_identity_inference?: Record<string, unknown> | null
  speaker_gender_estimate?: Record<string, unknown> | null
  speaker_age_group_estimate?: Record<string, unknown> | null
  [key: string]: unknown
}

/** speaker_label → 화자 메타 룩업 1행 (utterance/label 라인 배선용). */
export interface SpeakerLookupEntry {
  /** owner_candidate / counterparty_candidate / unknown (안전선 #1). */
  role_candidate: ExternalSpeakerRole
  /** male / female / null — 확정 단어. 룩업 내부값(라인엔 미노출, call.json estimate 로만). */
  gender: string | null
  /** 예: '30대' / null. */
  voice_age: string | null
  /** 예: '교사' / null. 관계 PII — 기본 미노출(EXPOSE_SPEAKER_RELATION). */
  relation: string | null
}

export type SpeakerLookupMap = Map<string, SpeakerLookupEntry>

// ── 룩업맵 ────────────────────────────────────────────────────────────────

/**
 * session_speakers 행 배열 → speaker_label 룩업맵.
 * speaker_label 이 없는 행은 건너뛴다. SPEAKER_IVR 등 매핑 없는 화자는 호출측에서
 * 룩업 미스 → unknown 처리.
 */
export function buildSpeakerLookup(rows: SessionSpeakerRow[]): SpeakerLookupMap {
  const map: SpeakerLookupMap = new Map()
  for (const row of rows) {
    const label = typeof row.speaker_label === 'string' ? row.speaker_label : null
    if (!label) continue
    map.set(label, {
      role_candidate: mapSessionSpeakerRoleToCandidate(row.speaker_role),
      gender: nonEmptyStringOrNull(row.speaker_gender),
      voice_age: nonEmptyStringOrNull(row.speaker_voice_age_range),
      relation: nonEmptyStringOrNull(row.speaker_relation),
    })
  }
  return map
}

/**
 * speaker_label → role_candidate 조회. 룩업 미스(IVR/미매핑) → 'unknown'.
 */
export function lookupRoleCandidate(
  map: SpeakerLookupMap,
  speakerLabel: unknown,
): ExternalSpeakerRole {
  if (typeof speakerLabel !== 'string') return 'unknown'
  return map.get(speakerLabel)?.role_candidate ?? 'unknown'
}

// ── call.json speakers[] 섹션 ─────────────────────────────────────────────

/**
 * call.json `speakers[]` 객체 1개. SPEC §4.4 / §5.1.2~5.1.3 구조.
 *
 * 노출 정책: identity_inference / gender_estimate / age_group_estimate JSONB 가
 * 채워져 있으면(estimate value 존재) 그 값을 우선 사용하고, 현재처럼 null 스텁이면
 * 확정 컬럼(speaker_role/gender/voice_age)에서 candidate/estimate 형으로 파생한다.
 * 어느 경우든 disclaimer 를 붙여 안전선 #1(확정 단정 금지)을 준수한다.
 */
/**
 * 화자 영속 가명(speaker_persistent_id) 산출 컨텍스트.
 *
 * ★미역산(irreversible) 솔트해시 — 디렉터 승인안(2026-06-06).
 * 목적: 납품 데이터셋 *안에서만* 동일인물 cross-call 식별. 내부신원과의 역추적은 완전 차단.
 *   - salt: export 1회당 crypto.randomBytes 로 새로 생성, *어디에도 저장 안 함*(역산 불가 핵심).
 *           같은 납품 ZIP 내 모든 세션이 같은 salt → 데이터셋 내 cross-call 링크 유지,
 *           납품분 간/내부 DB 와는 링크 불가. salt 부재(null)면 가명 미산출.
 *   - identityKeyByRole: 역할별 cross-session 신원 키 (raw 미노출 — 해시 입력으로만 사용).
 *       owner(self) = sessions.user_id, counterparty(other) = sessions.peer_id.
 *       해당 신원 부재 → 그 역할 화자의 speaker_persistent_id = null.
 *   - consent 게이트: 동의(both_agreed) 세션만 salt 가 채워진다(builder 측 게이트). 미동의면
 *       salt=null 로 전달 → 전 화자 가명 null.
 */
export interface SpeakerPersistentIdContext {
  /** export 1회당 랜덤 솔트 (hex). null = 미동의/미적용 → 가명 미산출. */
  salt: string | null
  /** 역할별 cross-session 신원 키 (raw). 해시 입력 전용 — 외부 노출 금지. */
  identityKeyByRole: {
    owner_candidate: string | null
    counterparty_candidate: string | null
  }
}

/**
 * speaker_persistent_id = sha256(identity_key + salt) 앞 16자 (hex).
 *
 * identity_key 또는 salt 가 없으면 null (미역산 가명 생성 불가 → 정직하게 null).
 * raw identity_key 는 절대 외부로 나가지 않는다(해시 결과 16hex 만 반환).
 */
export function computeSpeakerPersistentId(
  identityKey: string | null,
  salt: string | null,
): string | null {
  if (!identityKey || !salt) return null
  return createHash('sha256').update(identityKey + salt).digest('hex').slice(0, 16)
}

export function buildSpeakerExternal(
  row: SessionSpeakerRow,
  relationCounts: ReadonlyMap<string, number> = new Map(),
  persistentIdCtx: SpeakerPersistentIdContext | null = null,
): Record<string, unknown> {
  // 영속 가명: 역할(owner/counterparty)별 신원 키를 골라 salt 해시. 미동의/신원부재 → null.
  // ⚠️ raw identity_key(user_id/peer_id)는 해시 입력으로만 — 절대 외부 노출 X.
  const roleCandidate = mapSessionSpeakerRoleToCandidate(row.speaker_role)
  const identityKey =
    persistentIdCtx === null
      ? null
      : roleCandidate === 'owner_candidate'
        ? persistentIdCtx.identityKeyByRole.owner_candidate
        : roleCandidate === 'counterparty_candidate'
          ? persistentIdCtx.identityKeyByRole.counterparty_candidate
          : null
  const out: Record<string, unknown> = {
    speaker_label: nonEmptyStringOrNull(row.speaker_label),
    // 미역산 솔트해시 가명 (데이터셋 내 cross-call 동일인물 식별 전용). null = 미동의/신원부재.
    speaker_persistent_id: computeSpeakerPersistentId(
      identityKey,
      persistentIdCtx?.salt ?? null,
    ),
    identity_inference: buildIdentityInference(row),
    gender_estimate: buildGenderEstimate(row),
    age_group_estimate: buildAgeGroupEstimate(row),
  }
  if (EXPOSE_SPEAKER_RELATION) {
    // SPEC §4.4(개정): K-익명성(K=5) 게이트 + 일반화 tier. 데이터셋 전체 빈도표 기준.
    // 흔한값(count>=5)→원문, 희귀값→일반화 tier, tier 도 희귀/관계부재/미지값→null.
    out.relation_candidate = resolveRelationCandidate(row.speaker_relation, relationCounts)
  }
  return out
}

/**
 * 세션 전체 speakers[] 배열.
 *
 * @param relationCounts  데이터셋 전체 관계 빈도표(K 게이트 판정 기준). 미주입 시 빈 맵
 *   → 모든 관계값 count=0 으로 간주돼 일반화/ null 게이트가 보수적으로 작동.
 */
export function buildSpeakersSection(
  rows: SessionSpeakerRow[],
  relationCounts: ReadonlyMap<string, number> = new Map(),
  persistentIdCtx: SpeakerPersistentIdContext | null = null,
): Array<Record<string, unknown>> {
  return rows
    .filter((r) => typeof r.speaker_label === 'string' && r.speaker_label.length > 0)
    .map((r) => buildSpeakerExternal(r, relationCounts, persistentIdCtx))
}

// ── 서브객체 빌더 ─────────────────────────────────────────────────────────

function buildIdentityInference(row: SessionSpeakerRow): Record<string, unknown> {
  const jsonb = asObject(row.speaker_identity_inference)
  // JSONB predicted_role 가 채워져 있으면 그것을, 아니면 확정 speaker_role 에서 파생.
  const rawPredicted = jsonb?.predicted_role
  const predicted =
    typeof rawPredicted === 'string' && rawPredicted.length > 0
      ? mapSessionSpeakerRoleToCandidate(rawPredicted)
      : mapSessionSpeakerRoleToCandidate(row.speaker_role)

  return {
    predicted_role: predicted,
    owner_probability: numOrNull(jsonb?.owner_probability),
    counterparty_probability: numOrNull(jsonb?.counterparty_probability),
    confidence: numOrNull(jsonb?.confidence),
    method: sanitizeExternalMethod(jsonb?.method ?? row.speaker_role_source),
    status: typeof jsonb?.status === 'string' ? jsonb.status : 'not_available',
    counterparty_count: numOrNull(jsonb?.counterparty_count),
    disclaimer: SPEAKER_INFERENCE_DISCLAIMER,
    // 안전선 #4: identity_inference.note(자유 텍스트) 미노출.
  }
}

function buildGenderEstimate(row: SessionSpeakerRow): Record<string, unknown> {
  const jsonb = asObject(row.speaker_gender_estimate)
  const jsonbValue = nonEmptyStringOrNull(jsonb?.value)
  // estimate JSONB value 가 채워져 있으면 그것을, 아니면 확정 speaker_gender 에서 파생.
  const value = jsonbValue ?? nonEmptyStringOrNull(row.speaker_gender)
  return {
    value: value ?? 'unknown', // 확정 단어 아님 — disclaimer 로 추정값 명시.
    confidence: numOrNull(jsonb?.confidence),
    method: sanitizeExternalMethod(jsonb?.method),
    disclaimer: SPEAKER_ESTIMATE_DISCLAIMER,
  }
}

function buildAgeGroupEstimate(row: SessionSpeakerRow): Record<string, unknown> {
  const jsonb = asObject(row.speaker_age_group_estimate)
  const jsonbVoice = nonEmptyStringOrNull(jsonb?.voice_age_range ?? jsonb?.value)
  const voiceAge = jsonbVoice ?? nonEmptyStringOrNull(row.speaker_voice_age_range)
  const speechAge =
    nonEmptyStringOrNull(jsonb?.speech_age_range) ??
    nonEmptyStringOrNull(row.speaker_speech_age_range)
  return {
    voice_age_range: voiceAge, // null = 미산출(날조 금지).
    speech_age_range: speechAge,
    confidence: numOrNull(jsonb?.confidence),
    method: sanitizeExternalMethod(jsonb?.method),
    disclaimer: SPEAKER_ESTIMATE_DISCLAIMER,
  }
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function nonEmptyStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}
