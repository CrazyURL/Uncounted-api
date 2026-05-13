// ── 통화 단위 PII 위험도 분석 (STAGE 11.5 백엔드 포팅) ──────────────────
//
// uncounted-admin/src/lib/piiRisk.ts 와 동일 로직.
// 클라이언트가 검수 UI 에 표시하는 위험도와 백엔드 자동 승인 차단 기준이
// 일치해야 하므로 양쪽 모두 같은 알고리즘으로 판정.

export type RiskLevel = 'low' | 'medium' | 'high'

export interface SessionRiskResult {
  level: RiskLevel
  reasons: string[]
  dangerUttIds: Set<string>
}

const AUTH_KEYWORDS = [
  '비밀번호', '패스워드', '비번', '암호',
  '인증번호', 'OTP', '확인번호', '일회용번호',
  'PIN', '핀번호',
  '주민번호', '주민등록번호',
  '카드번호', '계좌번호', 'CVC', '유효기간',
]
const DICTATION_VERBS = [
  '불러줄', '알려줄', '받아적', '받아 적', '보내줄', '적어', '메모해',
]
const AUTH_REGEX = new RegExp(
  `(${AUTH_KEYWORDS.map(escapeRe).join('|')})|(${DICTATION_VERBS.map(escapeRe).join('|')})`,
  'i',
)
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isShortNumericish(text: string | null | undefined, durationSec: number): boolean {
  if (!text || durationSec > 2.0) return false
  const stripped = text.replace(/[\s.,!?·~-]/g, '')
  if (stripped.length === 0) return false
  const digitCount = (stripped.match(/\d/g) ?? []).length
  return digitCount >= 2 && digitCount / stripped.length >= 0.5
}

interface UtteranceForRisk {
  id: string
  text: string | null
  duration_seconds: number
}

export function analyzeSessionRisk(utterances: UtteranceForRisk[]): SessionRiskResult {
  const dangerUttIds = new Set<string>()
  const reasons: string[] = []

  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i]
    if (!u.text) continue
    const m = AUTH_REGEX.exec(u.text)
    if (!m) continue
    const matched = m[1] ?? m[2]
    reasons.push(`인증정보 키워드 "${matched}" 등장 — ${i + 1}번 발화`)
    for (let j = i; j < Math.min(i + 6, utterances.length); j++) {
      dangerUttIds.add(utterances[j].id)
    }
  }

  let run = 0
  let runStart = -1
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i]
    if (isShortNumericish(u.text, u.duration_seconds)) {
      if (run === 0) runStart = i
      run += 1
      if (run >= 3) {
        for (let j = runStart; j <= i; j++) dangerUttIds.add(utterances[j].id)
      }
    } else {
      if (run >= 3) {
        reasons.push(`짧은 숫자 발화 ${run}건 연속 — ${runStart + 1}~${i}번 (받아적기 의심)`)
      }
      run = 0
      runStart = -1
    }
  }
  if (run >= 3) {
    reasons.push(`짧은 숫자 발화 ${run}건 연속 — ${runStart + 1}~${utterances.length}번`)
  }

  const level: RiskLevel = dangerUttIds.size > 0 ? 'high' : 'low'
  return { level, reasons, dangerUttIds }
}

// ── 5조건 + 통화 위험도 통합 검사 (STAGE 12 자동 승인 게이트) ────────────

const DIGIT_7PLUS_RE = /\d[\d\s.-]{6,}\d/

interface UtteranceForApproval {
  id: string
  text: string | null
  duration_seconds: number
  speaker_id: string | null
  quality_grade: string | null
  review_status: string
}

export interface SessionApprovalCheck {
  eligible: boolean
  reasons: string[]
}

/**
 * 세션이 자동 승인 가능한지 검사.
 *
 * 5조건 (모든 utterance 대상):
 *   1. quality_grade = 'A'
 *   2. text 에 숫자 7자리+ 없음
 *   3. duration_seconds >= 1.0
 *   4. transcript_text 비어있지 않음
 *   5. speaker_id 정상 할당
 *
 * + 통화 위험도 not high (분산 PII / 인증 키워드 없음)
 *
 * excluded 발화는 검사 대상에서 제외 (이미 검수자가 제외 표시).
 */
export function checkSessionAutoApproval(
  utterances: UtteranceForApproval[],
): SessionApprovalCheck {
  const reasons: string[] = []
  const includable = utterances.filter((u) => u.review_status !== 'excluded')

  if (includable.length === 0) {
    return { eligible: false, reasons: ['포함 발화 0건'] }
  }

  for (const u of includable) {
    if (u.quality_grade !== 'A') {
      reasons.push(`발화 ${u.id.slice(0, 8)} 품질등급 ${u.quality_grade ?? 'null'} (A 미달)`)
    }
    if (u.text && DIGIT_7PLUS_RE.test(u.text)) {
      reasons.push(`발화 ${u.id.slice(0, 8)} 숫자 7자리+ 포함`)
    }
    if (u.duration_seconds < 1.0) {
      reasons.push(`발화 ${u.id.slice(0, 8)} 길이 ${u.duration_seconds.toFixed(2)}s (1초 미만)`)
    }
    if (!u.text || u.text.trim().length === 0) {
      reasons.push(`발화 ${u.id.slice(0, 8)} 텍스트 공백`)
    }
    if (!u.speaker_id) {
      reasons.push(`발화 ${u.id.slice(0, 8)} 화자 미할당`)
    }
  }

  const risk = analyzeSessionRisk(
    includable.map((u) => ({
      id: u.id,
      text: u.text,
      duration_seconds: u.duration_seconds,
    })),
  )
  if (risk.level === 'high') {
    reasons.push(`통화 PII 위험: ${risk.reasons.join(' / ')}`)
  }

  return { eligible: reasons.length === 0, reasons }
}
