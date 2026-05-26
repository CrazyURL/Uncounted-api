// ── counterpartyKey — sessions.title(원본 통화녹음 파일명) → 상대 identity 키 ──
//
// 배경: 휴대폰 통화녹음 원본 파일명 `통화 녹음 {id}_YYMMDD_HHMMSS`(삼성 규약)이
//   업로드 시 sessions.title 로 보존된다. {id} = 연락처 이름 또는 전화번호.
//   접두/접미를 벗기고 {id} 로 그룹하면 연락처(상대) 단위 그룹이 소급 성립한다.
//   출처: scripts/analysis/relationship_identity_from_title_finding_20260526.md
//
// 불변식 (PII 보호):
//   - raw 이름/번호(normalizedId)는 절대 저장/로그/출력 금지 — 해시 입력 전용.
//   - 외부에 남기는 값은 identityHash / phoneHash / maskedDisplayName(비식별) 뿐.
//
// 키 품질:
//   - title_phone = 강키(0.90). normalizePhone 후 사실상 phone 식별.
//   - title_name  = 약키(0.50). 동명이인(false-merge)·표기변형(false-split) 위험.
//     정밀 해소(번호 강키·음성지문)는 관계/identity-bootstrap 후속 트랙 소관.
//
// 순수 함수 — secret 은 호출부(스크립트/라우트)가 process.env.PHONE_HASH_SECRET 에서
// 읽어 주입(테스트 가능). 본 모듈은 env 를 직접 읽지 않는다.

import { createHmac } from 'node:crypto'
import { normalizePhone } from './callFingerprint.js'

export type CounterpartyKind = 'title_phone' | 'title_name'

export interface ParsedCounterparty {
  kind: CounterpartyKind
  /** 정규화된 {id} — PII. 해시 입력 전용, 저장/로그 금지. */
  normalizedId: string
  /** 키 신뢰도: title_phone=0.90(강키) / title_name=0.50(약키) */
  confidence: number
}

export interface CounterpartyKey {
  kind: CounterpartyKind
  /** HMAC(secret, `${userId}|${kind}|${normalizedId}`) — peers.peer_identity_hash */
  identityHash: string
  /** title_phone 일 때만 HMAC(secret, normalizedId) — peers.phone_hash. name 은 null */
  phoneHash: string | null
  confidence: number
}

// 접두 "통화 녹음 " + 접미 "_YYMMDD_HHMMSS". 접미의 **마지막** _\d{6}_\d{6} 에
// 앵커(.+ greedy)하여 {id} 에 '_'/날짜형 토큰이 포함돼도 보존.
const TITLE_RE = /^통화\s?녹음\s+(.+)_\d{6}_\d{6}$/

// 후행 호칭(긴 것 먼저). 한 번만 제거.
const TRAILING_HONORIFIC_RE = /(선생님|님|씨)$/

const PHONE_CONFIDENCE = 0.9
const NAME_CONFIDENCE = 0.5

/**
 * sessions.title 에서 raw {id} 추출. 패턴 불일치(마스킹된 title·잡음)면 null.
 * 비매칭은 에러가 아니라 스킵 신호다.
 */
export function parseCounterpartyTitle(title: string | null | undefined): string | null {
  if (!title) return null
  const m = TITLE_RE.exec(title.trim())
  if (!m) return null
  const rawId = m[1].trim()
  return rawId.length > 0 ? rawId : null
}

/** {id} 가 전화번호형인지: 숫자/+/구분기호로만 구성되고 자릿수가 충분한가. */
function looksLikePhone(rawId: string): boolean {
  if (!/^[\d+][\d+\-\s().]*$/.test(rawId)) return false
  const digits = rawId.replace(/\D/g, '')
  return digits.length >= 7
}

/** raw {id} → 분류 + 정규화. 번호는 normalizePhone, 이름은 NFC/공백/호칭 정리. */
export function normalizeCounterpartyId(rawId: string): ParsedCounterparty {
  if (looksLikePhone(rawId)) {
    return {
      kind: 'title_phone',
      normalizedId: normalizePhone(rawId),
      confidence: PHONE_CONFIDENCE,
    }
  }
  const normalizedId = rawId
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(TRAILING_HONORIFIC_RE, '')
    .trim()
  return {
    kind: 'title_name',
    normalizedId,
    confidence: NAME_CONFIDENCE,
  }
}

/** 정규화 결과 + userId + secret → 결정적 키. 사용자별·kind별 네임스페이스 분리. */
export function buildCounterpartyKey(
  userId: string,
  parsed: ParsedCounterparty,
  secret: string,
): CounterpartyKey {
  if (!secret) throw new Error('PHONE_HASH_SECRET not configured')
  const identityHash = createHmac('sha256', secret)
    .update(`${userId}|${parsed.kind}|${parsed.normalizedId}`)
    .digest('hex')
  const phoneHash =
    parsed.kind === 'title_phone'
      ? createHmac('sha256', secret).update(parsed.normalizedId).digest('hex')
      : null
  return { kind: parsed.kind, identityHash, phoneHash, confidence: parsed.confidence }
}

/**
 * title + userId + secret → 상대 identity 키. title 비매칭이거나 정규화 후
 * 빈 문자열이면 null(스킵).
 */
export function deriveCounterpartyKeyFromTitle(
  userId: string,
  title: string | null | undefined,
  secret: string,
): CounterpartyKey | null {
  const rawId = parseCounterpartyTitle(title)
  if (rawId === null) return null
  const parsed = normalizeCounterpartyId(rawId)
  if (parsed.normalizedId.length === 0) return null
  return buildCounterpartyKey(userId, parsed, secret)
}

/** peers.display_name(NOT NULL)용 비식별 토큰. raw 식별정보 미포함. */
export function maskedDisplayName(identityHash: string): string {
  return `상대#${identityHash.slice(0, 8)}`
}
