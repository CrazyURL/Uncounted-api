// ── peers 속성 잠금(human confirm) 순수 헬퍼 ──────────────────────────────
// admin 이 peer 속성(관계/성별/연령/카테고리)을 확정하면 override_locked=true 로 잠근다.
// 잠긴 행은 GPU 스코어러/워커가 절대 안 덮음(enforcement 는 GPU writer 측, 본 레이어는 플래그).
// 본 모듈은 DB·HTTP 무관 순수 함수 — 라우트가 검증/업데이트행 빌드에 사용(테스트 가능).
// 설계: plans/snazzy-munching-planet.md (peers 속성 잠금 레이어)

// 확정 가능한 enum (087 CHECK + relation_inference.py 11종 라벨과 일치).
export const RELATIONSHIP_VALUES = new Set([
  '부모', '배우자', '형제자매', '자녀', '친구',
  '직장상사', '직장동료', '거래처', '교사', '고객', '기타',
])
export const GENDER_VALUES = new Set(['male', 'female', 'non_binary'])
export const ATTR_CATEGORY_VALUES = new Set(['가족', '업무'])
export const AGE_RANGE_VALUES = new Set(['20대', '30대', '40대', '50대+'])

export interface PeerConfirmInput {
  relationship?: string | null
  attr_category?: string | null
  gender?: string | null
  voice_age_range?: string | null
  speech_age_range?: string | null
}

export type PeerConfirmResult =
  | { update: Record<string, unknown> }
  | { error: string }

/**
 * 사람 확정 → peers UPDATE 행 빌드.
 * - 항상: override_locked=true, locked_by, locked_at, attr_state='HUMAN_LOCKED', updated_at.
 * - 제공된 속성만 set(미제공=보존). 각 속성에 human_locked 출처 기록(relationship→rel_source,
 *   gender→gender_source). enum 위반 → {error}. 빈 body 도 잠금 자체는 유효(상태만 확정).
 */
export function buildPeerConfirmUpdate(
  body: PeerConfirmInput,
  lockedBy: string,
  nowIso: string,
): PeerConfirmResult {
  const update: Record<string, unknown> = {
    override_locked: true,
    locked_by: lockedBy,
    locked_at: nowIso,
    attr_state: 'HUMAN_LOCKED',
    updated_at: nowIso,
  }

  if (body.relationship != null) {
    if (!RELATIONSHIP_VALUES.has(body.relationship)) return { error: 'invalid relationship' }
    update.relationship = body.relationship
    update.rel_source = 'human_locked'
    update.rel_confidence = 1.0
  }
  if (body.gender != null) {
    if (!GENDER_VALUES.has(body.gender)) return { error: 'invalid gender' }
    update.gender = body.gender
    update.gender_source = 'human_locked'
  }
  if (body.attr_category != null) {
    if (!ATTR_CATEGORY_VALUES.has(body.attr_category)) return { error: 'invalid attr_category' }
    update.attr_category = body.attr_category
  }
  if (body.voice_age_range != null) {
    if (!AGE_RANGE_VALUES.has(body.voice_age_range)) return { error: 'invalid voice_age_range' }
    update.voice_age_range = body.voice_age_range
  }
  if (body.speech_age_range != null) {
    if (!AGE_RANGE_VALUES.has(body.speech_age_range)) return { error: 'invalid speech_age_range' }
    update.speech_age_range = body.speech_age_range
  }
  return { update }
}

export interface PeerQueueRow {
  id: string
  display_name?: string | null
  relationship?: string | null
  rel_source?: string | null
  rel_confidence?: number | null
  attr_category?: string | null
  attr_state?: string | null
  gender?: string | null
  gender_source?: string | null
  call_count?: number | null
}

/**
 * active-learning 큐 1행 매핑. call_count(전파가치=세션수)를 propagation_value /
 * auto_locks_if_confirmed(="이 peer 확정 시 자동잠기는 세션수" KPI)로 노출.
 * 원문(raw 이름/번호) 미노출 — display_name 은 비식별 토큰(상대#hash8).
 */
export function mapQueueRow(row: PeerQueueRow): Record<string, unknown> {
  const callCount = typeof row.call_count === 'number' ? row.call_count : 0
  return {
    id: row.id,
    display_name: row.display_name ?? null,
    relationship: row.relationship ?? null,
    rel_source: row.rel_source ?? null,
    rel_confidence: row.rel_confidence ?? null,
    attr_category: row.attr_category ?? null,
    attr_state: row.attr_state ?? null,
    gender: row.gender ?? null,
    gender_source: row.gender_source ?? null,
    call_count: callCount,
    propagation_value: callCount,
    auto_locks_if_confirmed: callCount,
  }
}
