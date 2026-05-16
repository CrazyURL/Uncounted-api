// ── Call Fingerprint — 통화 단위 unique entity 식별 + 후보 매칭 ─────────
//
// 외부 검토 5라운드 결과:
//   1. fingerprint 완벽 X → 후보 조회 + 필터링 + ambiguity check
//   2. phone normalization 필수 (+82/050/1588 한국 표준 포함)
//   3. quartile boundary 모호 → ±1 후보 + best/second delta ratio < 0.20 시 새 call
//   4. PREMIUM/STANDARD/EXCLUDED 등급 자동 분류 (가상번호·기업번호 보존)
//
// 외부 노출 (FK 의존성):
//   - normalizePhone, classifyPhone, classifyGrade
//   - generateSpeakersHash, generateFingerprint
//   - findExistingCall (DB 의존, supabase 클라이언트 주입)

import { createHash, createHmac } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

// ────────────────────────────────────────────────────────────
// 타입
// ────────────────────────────────────────────────────────────

export type PhoneType = 'mobile' | 'landline' | 'virtual' | 'corporate'
export type CallGrade = 'premium' | 'standard' | 'excluded'

export interface CallRecord {
  callerPhone: string
  calleePhone: string
  startedAt: Date
  duration: number // seconds
}

export interface ExistingCall {
  call_id: string
  fingerprint: string
  started_at: string
  started_at_minute_bucket: number
  started_at_quartile: number
  duration_seconds: number
  duration_bucket: number
  speakers_hash: string
  status: 'pending' | 'sellable' | 'sold' | 'locked'
  sold_at: string | null
}

export type MatchResult =
  | { type: 'no_match' }
  | { type: 'matched'; call: ExistingCall }
  | { type: 'ambiguous'; candidates: ExistingCall[]; reason: string }

// ────────────────────────────────────────────────────────────
// 1. Phone Normalization (한국 표준)
// ────────────────────────────────────────────────────────────
//
// "010-1234-5678", "+82 10-1234-5678", "010 1234 5678" → 모두 "01012345678"
// "+82-31-1234-5678" → "0311234567"
// "+82-50-1234-5678" → "0501234567" (가상번호)
// "1588-1234"        → "15881234"   (기업번호)

export function normalizePhone(phone: string): string {
  if (!phone) return ''
  let n = phone.replace(/[^\d+]/g, '')

  if (n.startsWith('+82')) n = '0' + n.substring(3)
  else if (n.startsWith('82') && n.length >= 10) n = '0' + n.substring(2)

  // 기업번호(1588 등)는 0 prefix 박지 않음
  if (/^1[45678]\d/.test(n)) return n

  if (!n.startsWith('0') && n.length >= 9) n = '0' + n
  return n
}

// ────────────────────────────────────────────────────────────
// 2. Phone Type 분류
// ────────────────────────────────────────────────────────────

export function classifyPhone(phone: string): PhoneType {
  const n = normalizePhone(phone)
  if (/^01[016789]/.test(n)) return 'mobile'
  if (/^050/.test(n)) return 'virtual'
  // 1588-1234 (8자리) 또는 1588 (prefix) 모두 매칭. 1[45678] 패턴: 1588/1577/1644/1599 etc.
  if (/^1[45678]\d{2}/.test(n)) return 'corporate'
  return 'landline'
}

// ────────────────────────────────────────────────────────────
// 3. Grade 분류 (PREMIUM / STANDARD / EXCLUDED)
// ────────────────────────────────────────────────────────────
//
// PREMIUM (50:50 분배 가능):
//   - mobile ↔ mobile
//   - mobile ↔ landline
// STANDARD (개인 측 100%, 비식별화 의무):
//   - corporate가 한쪽
//   - virtual이 한쪽 (개인 측만 권리자)
// EXCLUDED (거래 불가):
//   - virtual ↔ virtual (식별 불가)
//   - corporate ↔ corporate
//   - landline ↔ landline (사업체간 가능성, 시드 단계 보수적 제외)

export function classifyGrade(callerType: PhoneType, calleeType: PhoneType): CallGrade {
  const isMobileSide = (t: PhoneType) => t === 'mobile' || t === 'landline'

  if (callerType === 'mobile' && calleeType === 'mobile') return 'premium'
  if (
    (callerType === 'mobile' && calleeType === 'landline') ||
    (callerType === 'landline' && calleeType === 'mobile')
  )
    return 'premium'

  // 기업·가상번호가 한쪽 + 개인 모바일 = STANDARD
  if (callerType === 'mobile' && (calleeType === 'corporate' || calleeType === 'virtual'))
    return 'standard'
  if (calleeType === 'mobile' && (callerType === 'corporate' || callerType === 'virtual'))
    return 'standard'

  // 그 외 (양쪽 비개인) = EXCLUDED
  return 'excluded'
}

// ────────────────────────────────────────────────────────────
// 4. Speakers Hash (HMAC-SHA256, sorted)
// ────────────────────────────────────────────────────────────

export function generateSpeakersHash(callerPhone: string, calleePhone: string): string {
  const secret = process.env.PHONE_HASH_SECRET
  if (!secret) throw new Error('PHONE_HASH_SECRET not configured')

  const a = normalizePhone(callerPhone)
  const b = normalizePhone(calleePhone)
  const sorted = [a, b].sort().join('-')
  return createHmac('sha256', secret).update(sorted).digest('hex')
}

// ────────────────────────────────────────────────────────────
// 5. Fingerprint
// ────────────────────────────────────────────────────────────

export interface FingerprintParts {
  fingerprint: string
  minuteBucket: number
  quartile: number
  durationBucket: number
  speakersHash: string
}

export function generateFingerprintParts(call: CallRecord): FingerprintParts {
  const minuteBucket = Math.floor(call.startedAt.getTime() / 60000)
  const quartile = Math.floor(call.startedAt.getSeconds() / 15)
  const durationBucket = Math.floor(call.duration / 5)
  const speakersHash = generateSpeakersHash(call.callerPhone, call.calleePhone)

  const fingerprint = createHash('sha256')
    .update(`${minuteBucket}-${quartile}-${durationBucket}-${speakersHash}`)
    .digest('hex')

  return { fingerprint, minuteBucket, quartile, durationBucket, speakersHash }
}

export function generateFingerprint(call: CallRecord): string {
  return generateFingerprintParts(call).fingerprint
}

// ────────────────────────────────────────────────────────────
// 6. 후보 매칭 + Ambiguity Check
// ────────────────────────────────────────────────────────────
//
// quartile ±1 + duration ±1 후보 조회 → delta 정렬 → ambiguity ratio 검증
// best.delta < 60s 이고 ratio >= 0.20 → matched
// best.delta < 60s 이고 ratio <  0.20 → ambiguous (새 call + audit log)
// 후보 0건 → no_match

export const AMBIGUITY_THRESHOLD = 0.2
export const MAX_DELTA_SECONDS = 60

function timeDelta(existing: ExistingCall, call: CallRecord): number {
  const existingMs = new Date(existing.started_at).getTime()
  return Math.abs(existingMs - call.startedAt.getTime()) / 1000
}

export async function findExistingCall(
  sb: SupabaseClient,
  call: CallRecord,
): Promise<MatchResult> {
  const { minuteBucket, quartile, durationBucket, speakersHash } = generateFingerprintParts(call)

  const quartiles = [quartile - 1, quartile, quartile + 1].filter((q) => q >= 0 && q <= 3)
  const durationBuckets = [durationBucket - 1, durationBucket, durationBucket + 1].filter(
    (d) => d >= 0,
  )

  const { data: candidates, error } = await sb
    .from('calls')
    .select(
      'call_id, fingerprint, started_at, started_at_minute_bucket, started_at_quartile, duration_seconds, duration_bucket, speakers_hash, status, sold_at',
    )
    .eq('speakers_hash', speakersHash)
    .eq('started_at_minute_bucket', minuteBucket)
    .in('started_at_quartile', quartiles)
    .in('duration_bucket', durationBuckets)

  if (error) throw new Error(`findExistingCall query failed: ${error.message}`)
  if (!candidates || candidates.length === 0) return { type: 'no_match' }

  const scored = candidates
    .map((c: ExistingCall) => ({
      call: c,
      delta: timeDelta(c, call) * 2 + Math.abs(c.duration_seconds - call.duration),
    }))
    .sort((a, b) => a.delta - b.delta)

  const best = scored[0]
  if (best.delta >= MAX_DELTA_SECONDS) return { type: 'no_match' }

  if (scored.length === 1) {
    return { type: 'matched', call: best.call }
  }

  const second = scored[1]
  const ambiguityRatio = second.delta === 0 ? 0 : (second.delta - best.delta) / second.delta

  if (ambiguityRatio < AMBIGUITY_THRESHOLD) {
    return {
      type: 'ambiguous',
      candidates: scored.slice(0, 2).map((s) => s.call),
      reason: `ratio ${ambiguityRatio.toFixed(2)} < ${AMBIGUITY_THRESHOLD}`,
    }
  }

  return { type: 'matched', call: best.call }
}

// ────────────────────────────────────────────────────────────
// 7. Payout Release Date (다음달 15일)
// ────────────────────────────────────────────────────────────
//
// 5/1 거래  → 6/15 release (45일 hold)
// 5/31 거래 → 6/15 release (15일 hold)
// 6/1 거래  → 7/15 release (44일 hold)
// 매수자 LOI 시 AI Hub 표준 30일과 비교 재검토.

export function calculateReleaseDate(soldAt: Date): Date {
  const next = new Date(soldAt)
  next.setMonth(next.getMonth() + 1)
  next.setDate(15)
  next.setHours(0, 0, 0, 0)
  return next
}
