/**
 * Baseline Export Adapter (D6 골격) — internal canonical → baseline export record.
 *
 * 3-layer 원칙: internal canonical ≠ baseline export ≠ vendor package.
 * 본 어댑터는 internal canonical utterance 를 vendor-neutral "baseline" 레코드로
 * 변환하는 **단일 진입점**이다. enum/role/method 정규화를 export-builder 곳곳에
 * 흩어두지 않고 여기 한 곳으로 모은다(정규화 위치 단일화).
 *
 * ── 이번 PR 범위(D6 골격) ──────────────────────────────────────────────────
 *   - baseline 표준 네임스페이스 vs `uncounted_extensions` 네임스페이스 분리.
 *   - 기존 transforms.ts sanitize 함수 **재사용**(신규 정규화 로직 없음).
 *   - Sync Integrity Gate 훅 **자리(STUB)** + 타입 계약.
 *   - baseline 오염 방지 guard.
 *   ⚠️ 본 어댑터는 아직 export 파이프라인에 **배선되지 않는다**(standalone/additive).
 *      export-builder / packageBuilder 는 본 파일을 import 하지 않으며,
 *      미사용 시 기존 export 결과는 전혀 바뀌지 않는다.
 *
 * ── 이번 PR 범위 밖(금지) ───────────────────────────────────────────────────
 *   - D1 utterance pair export 안정화 / D2 is_overlapping / D3 confidence 산출
 *   - D4 pii_intervals emit / D5 acoustic masking
 *   - migration / DB write / worker / GPU 수정
 *   - export 성공 조건 완화, safety-checks/label-schema 변경
 *   (extension 값 산출은 D1~D3 구현 PR 소관. 여기선 envelope 타입/배치 자리만.)
 *
 * ── speaker role vocab (디렉터 결정 2026-05-27) ─────────────────────────────
 *   baseline role vocab 은 기존 export pipeline 기준을 **유지**한다:
 *     owner_candidate / counterparty_candidate / unknown.
 *   단 의미를 **anchor-user-relative speaker axis** 로 명확히 재정의한다:
 *     - owner_candidate       = 현재 업로드 세션의 anchor user(기준 사용자) 측 화자 후보
 *     - counterparty_candidate= 상대 통화자 후보
 *     - unknown               = 귀속 불확실
 *   이 vocab 은 **consent axis 아님**(동의 완료자 vs 미동의자 의미 아님),
 *   **call direction axis 아님**(발신/수신 Caller/Receiver 의미 아님).
 *   - consent 상태 → consent_meta lineage 로 분리 유지.
 *   - caller/receiver → 후속 별도 field 또는 extension 후보(이번 PR 미포함).
 *   장기 목표는 3축 분리(speaker_role / consent_role / call_direction)이나,
 *   본 골격 PR 에서는 구조 안정성 + 기존 safety gate 유지를 우선한다.
 */

import {
  sanitizeExternalMethod,
  sanitizeExternalLabelOrigin,
  sanitizeExternalSpeakerRole,
  dialogActToGroup,
  type ExternalMethod,
  type ExternalSpeakerRole,
  type DialogActGroup,
} from './transforms.js'

// ── 1. internal canonical 입력 (어댑터 입력 계약) ──────────────────────────

/**
 * 어댑터가 소비하는 internal canonical utterance 의 최소 부분집합.
 * export-builder 의 UtteranceRow 와 결합하지 않도록(standalone) 필요한 필드만 둔다.
 */
export interface InternalUtterance {
  id: string
  session_id: string
  sequence_order: number
  /** 익명 diarization 라벨 (예: SPEAKER_00). */
  speaker_label?: string | null
  /**
   * raw 화자 역할 (anchor-user-relative; self/other/owner/counterparty 등).
   * 외부로 그대로 노출하지 않고 sanitizeExternalSpeakerRole 로 정규화한다.
   */
  raw_speaker_role?: string | null
  start_sec: number | string
  end_sec: number | string
  /** 이미 마스킹된 전사 텍스트(text_masked). 원문 텍스트는 입력에 넣지 않는다. */
  text_masked?: string | null
  label_source?: string | null
  auto_label_model_version?: string | null
  dialog_act?: string | null
}

// ── 2. baseline / extension 네임스페이스 타입 ──────────────────────────────

/**
 * proprietary(uncounted_extensions) 값 1건의 envelope.
 * 모든 extension 값은 `{value, method, version, confidence}` 형태로 감싼다.
 */
export interface UncountedExtension<T = unknown> {
  value: T
  method: ExternalMethod
  /** 모델/메서드 버전 — §6 내부 모델명 노출 방지 위해 5종 allowlist 로 정규화. */
  version: ExternalMethod
  confidence: number | null
}

/**
 * baseline utterance 레코드 — vendor-neutral 표준 네임스페이스 + 분리된 extensions.
 * ⚠️ session-level 상수(audio_type/locale/dataset_provider 등)는 여기 두지 않는다.
 *    (label-schema.ts additionalProperties:false 가 utterance 레벨 비허용 키를 거부.)
 *    → BaselinePackageMetadata 로 분리.
 */
export interface BaselineUtteranceRecord {
  utterance_id: string
  session_id: string
  sequence_order: number
  start_sec: number
  end_sec: number
  /** 익명 diarization 라벨 (자유 문자열). */
  speaker_label: string
  /** anchor-user-relative 화자 역할 후보 (확정값 X). */
  speaker_role_candidate: ExternalSpeakerRole
  /** 마스킹된 텍스트. */
  text: string | null
  label_origin: ExternalMethod
  label_version: ExternalMethod
  /** dialog_act 표준 그룹(SPEC §5.1.4). 미매핑 시 null. */
  dialog_act_group: DialogActGroup | null
  /** proprietary 확장 — baseline 표준 키와 격리. */
  uncounted_extensions: Record<string, UncountedExtension>
}

/**
 * session/package-level 상수. utterance 레코드와 **분리**해 둔다.
 * (package manifest 쪽에 1회만 실리며, per-utterance 로 중복 emit 하지 않는다.)
 */
export interface BaselinePackageMetadata {
  audio_type: 'Mono'
  locale: string
  dataset_provider: string
  recording_context: string
}

export interface BaselineAdapterContext {
  packageMetadata: BaselinePackageMetadata
}

/** 권장 기본 package metadata(상수 주입 단일 지점). */
export const DEFAULT_BASELINE_PACKAGE_METADATA: BaselinePackageMetadata = {
  audio_type: 'Mono',
  locale: 'ko-KR',
  dataset_provider: 'Uncounted',
  recording_context: 'real_world_phone_call',
}

// ── 3. baseline 오염 방지 denylist ─────────────────────────────────────────

/**
 * baseline 표준 네임스페이스에 절대 들어가면 안 되는 proprietary 키 패턴.
 * (Phase 3~4 intelligence 류 — negotiation/persuasion/conflict 등.)
 * 이런 신호는 uncounted_extensions 로만 가야 하며, baseline 표준 키 오염은 reject.
 */
const BASELINE_POLLUTION_DENYLIST: readonly RegExp[] = [
  /negotiation/i,
  /persuasion|persuade/i,
  /escalation|escalat/i,
  /conflict/i,
  /aggressive/i,
  /pressure/i,
  /buyer_intent|sales_intent|buyer_pressure/i,
  /sentiment_trajectory/i,
]

/**
 * baseline 표준 네임스페이스(= uncounted_extensions 제외 top-level 키)에
 * proprietary 키가 섞였는지 검사. 매치 시 throw(fail-closed).
 */
export function assertNoBaselinePollution(record: BaselineUtteranceRecord): void {
  for (const key of Object.keys(record)) {
    if (key === 'uncounted_extensions') continue
    for (const re of BASELINE_POLLUTION_DENYLIST) {
      if (re.test(key)) {
        throw new Error(
          `[baselineAdapter] proprietary key "${key}" leaked into baseline namespace (use uncounted_extensions)`,
        )
      }
    }
  }
}

// ── 4. Sync Integrity Gate 훅 (STUB) ───────────────────────────────────────

/**
 * D1 의 8개 참조무결성 체크 이름. 타입으로 게이트 계약을 고정한다.
 * (audio ↔ transcript ↔ timing ↔ pii_interval 정합)
 */
export type SyncIntegrityCheckName =
  | 'duration_match'
  | 'pii_in_bounds'
  | 'mask_in_bounds'
  | 'transcript_audio_align'
  | 'utterance_id_file_match'
  | 'speaker_id_in_profile'
  | 'timeline_post_clip_match'
  | 'metadata_audio_pairing'

export interface SyncIntegrityCheck {
  name: SyncIntegrityCheckName
  ok: boolean
  detail: string
}

export interface SyncIntegrityResult {
  ok: boolean
  checks: SyncIntegrityCheck[]
}

const SYNC_INTEGRITY_CHECK_NAMES: readonly SyncIntegrityCheckName[] = [
  'duration_match',
  'pii_in_bounds',
  'mask_in_bounds',
  'transcript_audio_align',
  'utterance_id_file_match',
  'speaker_id_in_profile',
  'timeline_post_clip_match',
  'metadata_audio_pairing',
]

/**
 * Sync Integrity Gate — **최상위 납품 게이트**의 훅 자리(STUB).
 *
 * ⚠️ 본 PR(D6 골격)은 게이트의 **타입 계약과 연동 지점**만 확정한다.
 *    실제 참조무결성 검증과 **fail-closed 적용은 D1 구현 PR** 소관이다.
 *    현재는 모든 체크를 not_implemented 로 표시하고, 미배선 상태이므로
 *    기존 export 동작에 전혀 영향을 주지 않는다(ok:true).
 *
 * 연동 예정 지점(문서화): export-builder 가 ZIP staging 직전,
 *    validateExportSafety() 호출 인근에서 본 게이트를 호출하고,
 *    ok=false 면 packaging 을 중단(fail-closed)하도록 D1 에서 배선한다.
 */
export function runSyncIntegrityGate(): SyncIntegrityResult {
  const checks: SyncIntegrityCheck[] = SYNC_INTEGRITY_CHECK_NAMES.map((name) => ({
    name,
    ok: true,
    detail: 'not_implemented (D1)',
  }))
  return { ok: true, checks }
}

// ── 5. 메인 어댑터 ─────────────────────────────────────────────────────────

function toNum(v: number | string | null | undefined): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/**
 * proprietary 값 1건을 extension envelope 로 감싼다.
 * method/version 은 §6 노출 방지를 위해 5종 allowlist 로 정규화한다.
 */
export function wrapExtension<T>(
  value: T,
  opts: { method?: unknown; version?: unknown; confidence?: number | null } = {},
): UncountedExtension<T> {
  const confidence =
    typeof opts.confidence === 'number' && Number.isFinite(opts.confidence) ? opts.confidence : null
  return {
    value,
    method: sanitizeExternalMethod(opts.method),
    version: sanitizeExternalMethod(opts.version),
    confidence,
  }
}

/**
 * internal canonical utterance → baseline utterance 레코드.
 *
 * 정규화는 전부 기존 transforms.ts 함수에 위임(정규화 위치 단일화):
 *   - role  → sanitizeExternalSpeakerRole (anchor-user-relative, 확정값 금지)
 *   - origin→ sanitizeExternalLabelOrigin (5종 allowlist)
 *   - version→sanitizeExternalMethod      (내부 모델명 노출 방지)
 *   - dialog_act→dialogActToGroup         (SPEC 표준 그룹)
 *
 * extensions 는 호출자가 산출한 proprietary 값(D1~D3 결과)을 그대로 격리 배치한다.
 * 본 어댑터는 extension 값을 **계산하지 않는다**(골격 범위).
 *
 * @throws baseline 표준 네임스페이스에 proprietary 키가 섞이면.
 */
export function toBaselineUtterance(
  u: InternalUtterance,
  extensions: Record<string, UncountedExtension> = {},
): BaselineUtteranceRecord {
  const speakerLabel =
    typeof u.speaker_label === 'string' && u.speaker_label.length > 0 ? u.speaker_label : 'UNKNOWN'

  const record: BaselineUtteranceRecord = {
    utterance_id: u.id,
    session_id: u.session_id,
    sequence_order: u.sequence_order,
    start_sec: toNum(u.start_sec),
    end_sec: toNum(u.end_sec),
    speaker_label: speakerLabel,
    speaker_role_candidate: sanitizeExternalSpeakerRole(u.raw_speaker_role),
    text: typeof u.text_masked === 'string' ? u.text_masked : null,
    label_origin: sanitizeExternalLabelOrigin(u.label_source),
    label_version: sanitizeExternalMethod(u.auto_label_model_version),
    dialog_act_group: dialogActToGroup(u.dialog_act),
    uncounted_extensions: { ...extensions },
  }

  assertNoBaselinePollution(record)
  return record
}
