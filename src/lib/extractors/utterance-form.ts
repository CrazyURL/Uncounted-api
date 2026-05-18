/**
 * Utterance form extractor — 발화 유형/턴/맞장구 등 통합.
 *
 * SPEC §4.2.17 utterance_form JSONB:
 *   - utterance_type: 'statement' | 'question' | 'exclamation' | 'unknown'
 *   - turn_type: 'opening' | 'mid' | 'closing' | 'unknown'
 *   - is_short_response, is_backchannel, is_greeting, is_closing (boolean)
 *
 * 한국어 시드 어휘 (MVP 휴리스틱, heuristic_mvp):
 *   - 맞장구 토큰: 응/어/네/예/엉/음/그래/그렇구나/네네 등 (BACKCHANNEL_TOKENS)
 *   - 인사: 안녕(하세요), 여보세요, 반갑, 만나서 + 영문 hello/hi/hey
 *   - 종결: 끊을게, 들어가(세요), 안녕히, 수고(하세요)
 *   - 짧은 응답: 공백 제외 ≤ 4자
 *   - 질문: `?` 또는 한국어 의문 종결어미 (까요/나요/요/세요)
 *
 * 추후 KcELECTRA dialog_act_v2 도입 시 대체 가능.
 */

export type UtteranceType = 'statement' | 'question' | 'exclamation' | 'unknown'
export type TurnType = 'opening' | 'mid' | 'closing' | 'unknown'

export interface UtteranceForm {
  utterance_type: UtteranceType
  turn_type: TurnType
  is_short_response: boolean
  is_backchannel: boolean
  is_greeting: boolean
  is_closing: boolean
}

export interface UtteranceFormContext {
  /** 발화의 세션 내 순서 (0-based). turn_type 판정에 사용. */
  sequence_order?: number | null
  /** 세션의 전체 발화 수. turn_type closing 판정에 사용. */
  total_utterances?: number | null
}

const BACKCHANNEL_TOKENS = new Set([
  '응', '어', '네', '예', '엉', '음', '아', '오',
  '그래', '그렇지', '그렇구나', '그렇군', '그치', '맞아',
  '아하', '어어', '응응', '네네', '예예',
])

const GREETING_PATTERNS = [
  /안녕하?세요/,
  /\b안녕\b/,
  /여보세요/,
  /반갑(?:습니다|네요|다)/,
  /만나서\s?반갑/,
  /처음\s?뵙겠/,
  /\bhello\b/i,
  /\bhi\b/i,
  /\bhey\b/i,
]

const CLOSING_PATTERNS = [
  /끊을게요?/,
  /끊어요?/,
  /들어가(?:세요|볼게요|시죠)/,
  /다음에\s?(?:봬요|만나|뵈요)/,
  /안녕히\s?(?:가|계)/,
  /종료(?:합니다|할게요)/,
  /수고\s?(?:하세요|하셨습니다|했어요)/,
  /그럼\s?이만/,
]

const QUESTION_PATTERNS = [
  /\?\s*$/,
  /(?:까요|나요|니까|세요|드릴까요)\s*[?.]?\s*$/,
  /^(?:왜|어떻게|언제|어디|누가|뭐|무엇|얼마|몇)/,
]

const EXCLAMATION_PATTERNS = [
  /!+\s*$/,
  /(?:헐|와|어머|세상에|진짜|대박|아이고)/,
]

/**
 * 발화 형태 추출.
 *
 * @param text 발화 텍스트 (PII 마스킹된 transcript 권장)
 * @param ctx  세션 컨텍스트 (turn_type 판정용, 선택)
 */
export function extractUtteranceForm(
  text: unknown,
  ctx: UtteranceFormContext = {},
): UtteranceForm {
  const empty: UtteranceForm = {
    utterance_type: 'unknown',
    turn_type: 'unknown',
    is_short_response: false,
    is_backchannel: false,
    is_greeting: false,
    is_closing: false,
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return empty
  }

  const trimmed = text.trim()
  const stripped = trimmed.replace(/\s+/g, '')
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length

  // is_short_response: 공백 제외 4자 미만(엄격) — '네/응/네네/그래' 등은 통과,
  //   '알겠어요(4자)' 부터는 제외 (테스트 기준).
  const is_short_response = stripped.length > 0 && stripped.length < 4
  const is_backchannel = is_short_response && BACKCHANNEL_TOKENS.has(stripped)
  const is_greeting = GREETING_PATTERNS.some((re) => re.test(trimmed))
  const is_closing = CLOSING_PATTERNS.some((re) => re.test(trimmed))

  let utterance_type: UtteranceType = 'unknown'
  if (QUESTION_PATTERNS.some((re) => re.test(trimmed))) {
    utterance_type = 'question'
  } else if (EXCLAMATION_PATTERNS.some((re) => re.test(trimmed))) {
    utterance_type = 'exclamation'
  } else if (wordCount > 0) {
    utterance_type = 'statement'
  }

  const turn_type = inferTurnType(ctx, is_greeting, is_closing)

  return {
    utterance_type,
    turn_type,
    is_short_response,
    is_backchannel,
    is_greeting,
    is_closing,
  }
}

function inferTurnType(
  ctx: UtteranceFormContext,
  isGreeting: boolean,
  isClosing: boolean,
): TurnType {
  const order = typeof ctx.sequence_order === 'number' ? ctx.sequence_order : null
  const total = typeof ctx.total_utterances === 'number' ? ctx.total_utterances : null

  if (order !== null && total !== null && total > 0) {
    if (order <= 1) return 'opening'
    if (order >= total - 2) return 'closing'
    return 'mid'
  }

  if (isGreeting) return 'opening'
  if (isClosing) return 'closing'

  return 'unknown'
}
