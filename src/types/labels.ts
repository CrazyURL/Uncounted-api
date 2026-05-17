// ── 라벨 / 화자 추론 공유 타입 ───────────────────────────────────────────
// 072_label_extensions.sql 스키마 + GPU 파이프라인 자동라벨 구조와 1:1 대응

// ── Tier A: 즉시 도출 가능한 통계 라벨 ──────────────────────────────────

export type ConfidenceTier =
  | 'auto_confirmed'
  | 'auto_review'
  | 'needs_review'
  | 'admin_confirmed'

export type AudioQualityClass = 'excellent' | 'good' | 'fair' | 'poor'

// ── Tier B: 언어적 특성 라벨 ─────────────────────────────────────────────

export type HonorificLevel = 'honorific' | 'casual' | 'mixed' | 'unknown'

export type QuestionType =
  | 'yes_no'
  | 'wh'
  | 'choice'
  | 'confirmation'
  | 'rhetorical'
  | 'unknown'
  | 'na'

export type LanguageMixFlag = 'korean' | 'english' | 'mixed' | 'other'

// ── Tier C: JSONB placeholder 슬롯 (미래 ML 모델용) ───────────────────────

interface TierCSlot<TValue = unknown> {
  value: TValue | null
  confidence: number | null
  method: string
  version: string
}

export interface IntentSlot extends TierCSlot {
  version: `intent_v${number}`
}

export interface SatisfactionSlot extends TierCSlot<number> {
  scale: '1-5'
  version: `sat_v${number}`
}

export interface EscalationSlot extends TierCSlot<boolean> {
  version: `esc_v${number}`
}

export interface DialectRegionSlot extends TierCSlot<string> {
  version: `dialect_v${number}`
}

export interface NoiseClassSlot extends TierCSlot<string> {
  version: `noise_v${number}`
}

export interface FluencySlot extends TierCSlot<number> {
  scale: '1-5'
  version: `fluency_v${number}`
}

export interface ToxicitySlot extends TierCSlot<string> {
  version: `toxicity_v${number}`
  disclaimer: string
}

// ── session_speakers: 화자 정체성 추론 JSONB 슬롯 ─────────────────────────

export type SpeakerIdentityStatus =
  | 'zero_cycle_candidate'
  | 'candidate'
  | 'probable'
  | 'verified'
  | 'conflicted'
  | 'not_available'

export type SpeakerIdentityMethod =
  | 'zero_cycle_inference'
  | 'multi_counterparty_anchor'
  | 'not_available'

export interface SpeakerIdentityInference {
  predicted_role: 'owner_candidate' | 'counterparty_candidate' | 'unknown' | null
  owner_probability: number | null
  counterparty_probability: number | null
  confidence: number | null
  method: SpeakerIdentityMethod
  status: SpeakerIdentityStatus
  counterparty_count: number | null
  note: string
}

export interface SpeakerGenderEstimate {
  value: string | null
  confidence: number | null
  method: string
  disclaimer: string
}

export interface SpeakerAgeGroupEstimate {
  value: string | null
  confidence: number | null
  method: string
  disclaimer: string
}

// ── 라벨 신뢰도 메타 구조 (API 응답 보강용) ───────────────────────────────

export interface LabelConfidenceMeta {
  auto_label_tier: ConfidenceTier
  commercial_label: {
    method: 'rule_based_mvp' | 'ml_v1' | 'not_available'
    warning: 'heuristic_label' | null
    needs_verification: boolean
  }
  auto_label_review_required: boolean
  commercial_label_review_required: boolean
}

// ── PII 안전 구간 (original 필드 미포함) ─────────────────────────────────
// pii_intervals JSONB에서 original 제거 후 API 응답에 사용

export interface SafePiiInterval {
  startSec: number
  endSec: number
  maskType: string
  piiType: string
}
