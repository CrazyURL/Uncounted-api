// 창 B — approved 세션의 판매 적격(session_dataset_eligible) 평가.
//
// isExportEligible(eligibility.ts)는 export-time 게이트(이미 세팅된 boolean을 읽음).
// 이 helper는 그 boolean을 "무엇으로 세팅할지" 평가한다(입력이 더 많음: 발화 수/길이, WAV 존재).
//
// 1차 정책(사용자 확정):
//  - hard gate: approved + both_agreed + raw_audio_url + utterance_count>=1
//               + quality_tier 비-reject + 미잠금/제외 + PII 명시 block 아님
//  - 비-gate(warning만): PII 미완료(pii_not_cleared), 짧은 세션(too_short)
//  - reference_only.ready = eligible(WAV 불필요), embedded.ready = eligible && wav_present
//  - reason은 영속화하지 않고 호출 시 live 계산.
//
// PII/길이/품질의 hard gate 승격은 후속 트랙(masking/검수 안정, quality gate).

const MIN_UTT = 1
const SOFT_SHORT_SEC = 1 // 이 미만이면 too_short warning(차단 아님). MIN_SEC=0 == 길이 무게이트.

// 명시적 reject/block 값만 차단(대소문자 무시).
const QUALITY_REJECT_VALUES = new Set(['reject', 'rejected', 'c_reject'])
const PII_BLOCK_VALUES = new Set(['blocked', 'block', 'reject', 'rejected'])

export interface DatasetEligibilityInput {
  review_status?: string | null
  consent_status?: string | null
  raw_audio_url?: string | null
  utterance_count?: number | null
  total_duration_sec?: number | null
  session_quality_tier?: string | null
  strategy_locked?: boolean | null
  lock_reason?: string | null
  dup_status?: string | null
  dup_representative?: boolean | null
  pii_status?: string | null
  gpu_pii_status?: string | null
  is_pii_cleaned?: boolean | null
  /** 실제 S3 WAV 존재 여부(호출부가 주입). embedded readiness 판정용. */
  wav_present?: boolean
}

export interface ExportModeReadiness {
  ready: boolean
  reasons: string[]
}

export interface DatasetEligibilityResult {
  /** session_dataset_eligible 로 저장할 값(판매 후보 일반 적격). */
  eligible: boolean
  /** eligible=false 의 차단 사유(live). */
  reasons: string[]
  /** 차단하지 않는 경고(pii_not_cleared, too_short 등). */
  warnings: string[]
  exportModes: {
    reference_only: ExportModeReadiness
    embedded: ExportModeReadiness
  }
}

function isBlank(v: string | null | undefined): boolean {
  return v == null || v.trim() === ''
}

export function evaluateDatasetEligibility(input: DatasetEligibilityInput): DatasetEligibilityResult {
  const reasons: string[] = []
  const warnings: string[] = []

  // ── hard gates ──────────────────────────────────────────────
  if (input.review_status !== 'approved') reasons.push('review_not_approved')
  if (input.consent_status !== 'both_agreed') reasons.push('consent_not_both_agreed')
  if (isBlank(input.raw_audio_url)) reasons.push('missing_raw_audio')

  const uttCount = input.utterance_count ?? 0
  if (uttCount < MIN_UTT) {
    reasons.push(uttCount <= 0 ? 'missing_utterances' : 'too_few_utterances')
  }

  const tier = input.session_quality_tier?.trim().toLowerCase()
  if (tier && QUALITY_REJECT_VALUES.has(tier)) reasons.push('quality_rejected')

  if (input.strategy_locked === true || !isBlank(input.lock_reason)) {
    reasons.push('locked_or_disputed')
  }

  // 중복-비대표만 제외(dup_status 가 none/null 이 아니고 대표가 아닌 경우).
  if (!isBlank(input.dup_status) && input.dup_status !== 'none' && input.dup_representative === false) {
    reasons.push('excluded')
  }

  // PII: 1차는 명시 block 값만 차단.
  const piiStatus = input.pii_status?.trim().toLowerCase()
  if (piiStatus && PII_BLOCK_VALUES.has(piiStatus)) reasons.push('pii_blocked')

  // ── warnings (차단하지 않음) ─────────────────────────────────
  // PII 미완료: gpu_pii_status 가 done 이 아니거나 is_pii_cleaned 가 true 가 아님.
  const piiCleared = input.gpu_pii_status === 'done' || input.is_pii_cleaned === true
  if (!piiCleared && !(piiStatus && PII_BLOCK_VALUES.has(piiStatus))) {
    warnings.push('pii_not_cleared')
  }
  if (input.total_duration_sec != null && input.total_duration_sec < SOFT_SHORT_SEC) {
    warnings.push('too_short')
  }

  const eligible = reasons.length === 0

  const refReasons = [...reasons]
  const embReasons = [...reasons]
  const wavPresent = input.wav_present === true
  if (eligible && !wavPresent) embReasons.push('wav_missing_for_embedded')

  return {
    eligible,
    reasons,
    warnings,
    exportModes: {
      reference_only: { ready: eligible, reasons: refReasons },
      embedded: { ready: eligible && wavPresent, reasons: embReasons },
    },
  }
}
