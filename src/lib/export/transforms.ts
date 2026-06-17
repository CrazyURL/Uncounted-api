/**
 * External export transforms — 외부 ZIP 직전 변환 전용.
 *
 * 안전선:
 *   - #1: self/other 화자 확정값 외부 노출 X.
 *         → owner/counterparty (DB 확정 값) → owner_candidate/counterparty_candidate.
 *         → self/other/peer/그 외 → unknown (확정 표현 금지).
 *   - #6: 내부 모델명 (aihub_*, kcelectra_*, whisperx_* 등) 외부 노출 X.
 *         → automatic / supervised_model / rule_based_mvp / heuristic_mvp / not_available 5종.
 *         (+ self_declared: 모델/휴리스틱이 아닌 사용자 자기신고 출처 — self 화자 성별 등.
 *          모델명이 아니라 일반 출처 범주이므로 #6 누출 위험 없음.)
 *
 * 본 함수들은 DB 저장 X — export-builder 가 ZIP 빌드 직전에만 호출.
 */

// ── 1. method 일반화 ─────────────────────────────────────────────────────

export type ExternalMethod =
  | 'automatic'
  | 'supervised_model'
  | 'rule_based_mvp'
  | 'heuristic_mvp'
  | 'self_declared'
  | 'not_available'

const METHOD_PATTERNS: Array<[RegExp, ExternalMethod]> = [
  // automatic — STT / diarization / speaker embedding engines
  [/^automatic$/i, 'automatic'],
  [/whisperx/i, 'automatic'],
  [/^whisper(?:_v\d+)?/i, 'automatic'],
  [/pyannote/i, 'automatic'],
  [/wespeaker/i, 'automatic'],

  // supervised_model — labeled-data classifiers (KcELECTRA / AI Hub / KR-ELECTRA 등)
  [/^supervised_model$/i, 'supervised_model'],
  [/aihub/i, 'supervised_model'],
  [/kcelectra/i, 'supervised_model'],
  [/kc[-_]?electra/i, 'supervised_model'],
  [/kr[-_]?electra/i, 'supervised_model'],
  [/snunlp/i, 'supervised_model'],
  [/huggingface/i, 'supervised_model'],
  [/^finetune/i, 'supervised_model'],

  // rule_based_mvp
  [/^rule_based_mvp$/i, 'rule_based_mvp'],
  [/^rule(?:_v\d+)?$/i, 'rule_based_mvp'],

  // heuristic_mvp
  [/^heuristic_mvp$/i, 'heuristic_mvp'],
  [/^heuristic(?:_v\d+)?$/i, 'heuristic_mvp'],

  // self_declared — 사용자 자기신고(모델/휴리스틱 아님). self 화자 demographics 출처.
  [/^self_declared$/i, 'self_declared'],

  // not_available — explicit pass-through
  [/^not_available$/i, 'not_available'],
]

export function sanitizeExternalMethod(value: unknown): ExternalMethod {
  if (typeof value !== 'string' || value.length === 0) return 'not_available'
  for (const [re, target] of METHOD_PATTERNS) {
    if (re.test(value)) return target
  }
  return 'not_available'
}

// ── 2. label_origin 일반화 (method 와 동일 allowlist) ─────────────────────

/**
 * label_origin 도 method 와 동일한 5종 allowlist 로 일반화.
 * (내부 모델명/학습 출처 키워드가 외부 노출되지 않도록 #6 통합 처리)
 */
export function sanitizeExternalLabelOrigin(value: unknown): ExternalMethod {
  return sanitizeExternalMethod(value)
}

// ── 3. speaker role 일반화 (#1 self/other 확정 금지) ─────────────────────

export type ExternalSpeakerRole = 'owner_candidate' | 'counterparty_candidate' | 'unknown'

/**
 * DB 확정 값 (`owner`/`counterparty`) → `_candidate` 형 노출.
 * 그 외 모든 값 (self/other/peer/null/empty 등) → `unknown` (안전선 #1).
 */
export function sanitizeExternalSpeakerRole(value: unknown): ExternalSpeakerRole {
  if (typeof value !== 'string') return 'unknown'

  const v = value.toLowerCase().trim()
  if (v === 'owner' || v === 'owner_candidate') return 'owner_candidate'
  if (v === 'counterparty' || v === 'counterparty_candidate') return 'counterparty_candidate'

  return 'unknown'
}

/**
 * session_speakers.speaker_role (heuristic, `self`/`other`) → 외부 candidate 형.
 *
 * 의미 매핑 (anchor user = 세션 업로더 = self = owner):
 *   - `self`  → `owner_candidate`
 *   - `other` → `counterparty_candidate`
 *   - `owner`/`counterparty` (이미 candidate 의미) → 동일 candidate
 *   - 그 외 (null/peer/empty 등) → `unknown`
 *
 * ★안전선 #1: 내부 확정 단어(self/other)는 절대 외부로 나가지 않는다.
 * 본 함수는 DB 의 self/other 를 owner/counterparty 로 *번역*한 뒤
 * {@link sanitizeExternalSpeakerRole} 가드(self/other→unknown)를 그대로 통과시킨다.
 * 즉 self/other 가 직접 노출될 경로는 존재하지 않는다.
 */
export function mapSessionSpeakerRoleToCandidate(value: unknown): ExternalSpeakerRole {
  if (typeof value !== 'string') return 'unknown'
  const v = value.toLowerCase().trim()
  // self/other → owner/counterparty 로 번역 후 안전선 가드 통과.
  if (v === 'self') return sanitizeExternalSpeakerRole('owner')
  if (v === 'other') return sanitizeExternalSpeakerRole('counterparty')
  return sanitizeExternalSpeakerRole(value)
}

// ── 4. dialog_act → group 매핑 (SPEC §5.1.4 DIALOG_ACT_TO_GROUP_v1) ──────

export type DialogActGroup =
  | '정보'
  | '질문/확인'
  | '요청/제안'
  | '감사/사과'
  | '사회적'
  | '응답'
  | '지시'
  | '감정 표현'
  | '기타'

const DIALOG_ACT_TO_GROUP_V1: Record<string, DialogActGroup> = {
  진술: '정보',
  질문: '질문/확인',
  확인: '질문/확인',
  요청: '요청/제안',
  제안: '요청/제안',
  감사: '감사/사과',
  사과: '감사/사과',
  인사: '사회적',
  동의: '응답',
  반대: '응답',
  부정: '응답',
  응답: '응답',
  명령: '지시',
  감탄: '감정 표현',
  기타: '기타',
}

/**
 * @returns 매핑 그룹명. 입력이 dialog_act 키와 매치되지 않으면 null.
 */
export function dialogActToGroup(value: unknown): DialogActGroup | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const trimmed = value.trim()
  return DIALOG_ACT_TO_GROUP_V1[trimmed] ?? null
}

// 이미 9-group 인 값(supervised head 산출 utterances.dialog_act_group)의 정합 검증.
// DB CHECK 가 9-group 정본만 허용하나, export 경계에서 방어적으로 한 번 더 검증한다.
const DIALOG_ACT_GROUP_SET: ReadonlySet<string> = new Set<DialogActGroup>([
  '정보', '질문/확인', '요청/제안', '감사/사과', '사회적', '응답', '지시', '감정 표현', '기타',
])

/**
 * 9-group 정본값이면 그대로 반환, 아니면 null. (supervised dialog_act_group 노출용)
 */
export function normalizeDialogActGroup(value: unknown): DialogActGroup | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return DIALOG_ACT_GROUP_SET.has(t) ? (t as DialogActGroup) : null
}
