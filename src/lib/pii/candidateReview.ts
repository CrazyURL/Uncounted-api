// PII-1B 관리자 판정용 순수 헬퍼.
//
// 두 가지 책임만 가진다(모두 부수효과 없는 순수 함수 — 단위 테스트 대상):
//   1) buildSnippet — transcript_text + char offset 로 후보 주변 "최소 스니펫"만 생성.
//      전체 transcript_text 는 절대 반환하지 않는다. (offset 앞뒤 contextChars 만큼만)
//   2) 관리자 결정 검증/매핑 — 허용 decision 값 검증 + pii_candidates update 행 생성.
//
// 안전 계약: 본 모듈은 입력 transcript 를 어디에도 로깅/저장하지 않는다. 스니펫(원문 일부)은
// 호출부(admin 전용 API 응답)로만 전달되며, 서버 로그/외부 export/public API 에 노출 금지.

/** 후보 양쪽으로 노출할 기본 컨텍스트 글자 수(앞/뒤 각각). */
export const CONTEXT_CHARS = 15

export interface CandidateSnippet {
  /** 후보 원문(예: 이름) — transcript[char_start..char_end]. */
  candidate_text: string
  /** 후보 앞 컨텍스트(최대 contextChars 글자). */
  context_before: string
  /** 후보 뒤 컨텍스트(최대 contextChars 글자). */
  context_after: string
  /** context_before + candidate_text + context_after. */
  snippet: string
  /** snippet 내 후보 시작 오프셋(= context_before.length). */
  highlight_start: number
  /** snippet 내 후보 끝 오프셋. */
  highlight_end: number
}

/**
 * 후보 주변 최소 스니펫을 만든다. 전체 transcript_text 는 절대 반환하지 않는다.
 *
 * 방어적 처리:
 *   - text 가 비었거나(null/empty), offset 이 null 이거나, 클램프 후 start>=end 면 null 반환.
 *   - offset 은 [0, text.length] 로 클램프(손상된 윈도우 방지).
 *
 * 한글은 BMP(서로게이트 페어 없음)라 Python code point offset == JS UTF-16 슬라이스가 일치한다.
 */
export function buildSnippet(
  text: string | null | undefined,
  charStart: number | null | undefined,
  charEnd: number | null | undefined,
  contextChars: number = CONTEXT_CHARS,
): CandidateSnippet | null {
  if (!text || typeof charStart !== 'number' || typeof charEnd !== 'number') {
    return null
  }
  const start = Math.max(0, Math.min(charStart, text.length))
  const end = Math.max(0, Math.min(charEnd, text.length))
  if (start >= end) {
    return null
  }
  const ctxStart = Math.max(0, start - contextChars)
  const ctxEnd = Math.min(text.length, end + contextChars)

  const context_before = text.slice(ctxStart, start)
  const candidate_text = text.slice(start, end)
  const context_after = text.slice(end, ctxEnd)
  const snippet = context_before + candidate_text + context_after

  return {
    candidate_text,
    context_before,
    context_after,
    snippet,
    highlight_start: context_before.length,
    highlight_end: context_before.length + candidate_text.length,
  }
}

/** 관리자 API 가 수용하는 decision 값. ('corrected' 는 본 API 에서 자동 파생하지 않는다.) */
export const VALID_DECISIONS = ['confirmed', 'rejected', 'skipped'] as const
export type CandidateDecision = (typeof VALID_DECISIONS)[number]

export function isValidDecision(v: unknown): v is CandidateDecision {
  return typeof v === 'string' && (VALID_DECISIONS as readonly string[]).includes(v)
}

export interface DecisionUpdateRow {
  admin_decision: CandidateDecision
  admin_selected_type: string | null
  reviewed_by: string
  decided_at: string
  status: 'decided'
}

/**
 * pii_candidates 업데이트 행 생성(순수). decision 은 받은 값을 그대로 저장하고,
 * 'corrected' 자동 승격은 하지 않는다(B2 UI 가 잘못된 가정을 하지 않도록).
 * 재판정 시 동일 키를 덮어쓰므로 idempotent — 같은 값 재전송은 no-op 과 동일 결과.
 */
export function buildDecisionUpdate(
  decision: CandidateDecision,
  selectedType: string | null,
  reviewedBy: string,
  decidedAt: string,
): DecisionUpdateRow {
  return {
    admin_decision: decision,
    admin_selected_type: selectedType,
    reviewed_by: reviewedBy,
    decided_at: decidedAt,
    status: 'decided',
  }
}
