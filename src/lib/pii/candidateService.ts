// PII 후보 서비스 (PII-1A).
//
// voice-api 의 기존 detect_pii_spans 단일 소스를 /api/v1/pii/detect-batch 로 호출하고,
// 응답(원문 미포함)을 pii_candidates 행으로 매핑한다.
//
// 안전 계약: 입력/출력 어디에도 원문 PII(matched_text/original_text) 가 포함되지 않는다.
// detect-batch 응답은 type/offset/confidence/tier 만 담고 있으며, 본 모듈은 그대로 보존한다.

export type ConfidenceTier = 'auto_confirmed' | 'needs_human_decision' | 'auto_rejected'

export interface DetectBatchItem {
  utterance_id: string
  text: string
}

export interface DetectedCandidate {
  type: string
  char_start: number
  char_end: number
  confidence: number
  high_precision_pattern: boolean
  confidence_tier: ConfidenceTier
}

export interface DetectBatchResultItem {
  utterance_id: string
  candidates: DetectedCandidate[]
}

export interface PiiCandidateRow {
  utterance_id: string
  session_id: string
  predicted_type: string
  confidence: number
  confidence_tier: ConfidenceTier
  high_precision_pattern: boolean
  char_start: number
  char_end: number
  source: string
  model_version: string | null
  status: 'pending'
}

const DEFAULT_BASE_URL = process.env.VOICE_API_URL ?? 'http://localhost:8001'

interface DetectBatchOptions {
  fetchImpl?: typeof fetch
  baseUrl?: string
  enableNameMasking?: boolean
}

/** voice-api detect-batch 호출. 원문은 전송하되(탐지에 필요) 응답에는 원문이 없다. */
export async function detectBatch(
  items: ReadonlyArray<DetectBatchItem>,
  opts: DetectBatchOptions = {},
): Promise<DetectBatchResultItem[]> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const res = await fetchImpl(`${baseUrl}/api/v1/pii/detect-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items,
      enable_name_masking: opts.enableNameMasking ?? true,
    }),
  })
  if (!res.ok) {
    const detail = typeof res.text === 'function' ? await res.text() : ''
    throw new Error(`voice-api detect-batch failed (${res.status}): ${detail}`)
  }
  const body = (await res.json()) as { results?: DetectBatchResultItem[] }
  return body.results ?? []
}

/** detect-batch 후보 → pii_candidates insert 행. 원문 키는 절대 포함하지 않는다. */
export function toCandidateRows(
  utteranceId: string,
  sessionId: string,
  candidates: ReadonlyArray<DetectedCandidate>,
  modelVersion: string | null,
): PiiCandidateRow[] {
  return candidates.map((c) => ({
    utterance_id: utteranceId,
    session_id: sessionId,
    predicted_type: c.type,
    confidence: c.confidence,
    confidence_tier: c.confidence_tier,
    high_precision_pattern: c.high_precision_pattern,
    char_start: c.char_start,
    char_end: c.char_end,
    source: 'voice_api_detect_spans',
    model_version: modelVersion,
    status: 'pending',
  }))
}
