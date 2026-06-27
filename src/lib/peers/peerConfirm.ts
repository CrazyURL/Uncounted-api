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

// ── peer 자가신고(동의 시) → peers 빌더 (088, peer_stated) ──────────────────
// owner enum 카테고리값(한국어). gender 만 영문(peers.gender=male/female/non_binary).
export const REGION_VALUES = new Set(['수도권', '영남', '호남', '충청', '강원', '제주', '해외'])
export const ACCENT_VALUES = new Set(['표준', '경상도', '전라도', '충청도', '강원도', '제주도', '혼합'])
export const LANGUAGE_VALUES = new Set([
  '한국어(ko-KR)', '영어(en-US)', '중국어(zh-CN)', '일본어(ja-JP)', '기타',
])

export interface PeerSelfReportInput {
  gender?: string | null // 영문 male/female/non_binary (peer.html 제출)
  age_band?: string | null // 20대|30대|40대|50대+
  region_group?: string | null
  accent_group?: string | null
  primary_language?: string | null
}

/**
 * 상대 자가신고(동의 시) → peers UPDATE 행.
 * - override_locked=true(자가신고=권위, 추론·재처리 미덮음), gender_source='peer_stated',
 *   attr_state='peer_stated_unverified'(GPU cross-check 전 초기상태).
 * - enum 위반/미입력 필드는 skip(동의 자체는 실패시키지 않음 — consent 우선). 유효 필드 0개 →
 *   null(peers write skip, graceful). 연령은 voice_age_range 슬롯(source 가 음향 아닌 자가신고 표기).
 * - 필수(성별·연령)는 peer.html 클라이언트가 강제(서버는 graceful — 롤아웃·구클라 안전).
 */
export function buildPeerSelfReportUpdate(
  body: PeerSelfReportInput,
  nowIso: string,
): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {}
  if (body.gender != null && GENDER_VALUES.has(body.gender)) fields.gender = body.gender
  if (body.age_band != null && AGE_RANGE_VALUES.has(body.age_band)) fields.voice_age_range = body.age_band
  if (body.region_group != null && REGION_VALUES.has(body.region_group)) fields.region_group = body.region_group
  if (body.accent_group != null && ACCENT_VALUES.has(body.accent_group)) fields.accent_group = body.accent_group
  if (body.primary_language != null && LANGUAGE_VALUES.has(body.primary_language)) {
    fields.primary_language = body.primary_language
  }
  if (Object.keys(fields).length === 0) return null // 유효 자가신고 없음 → peers write skip
  return {
    ...fields,
    gender_source: 'peer_stated',
    override_locked: true,
    attr_state: 'peer_stated_unverified',
    locked_at: nowIso,
    updated_at: nowIso,
  }
}
