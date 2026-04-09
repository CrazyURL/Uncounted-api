// ── PII 구간 유효성 검사 헬퍼 ─────────────────────────────────────────────────

export interface PiiIntervalInput {
  startSec: number
  endSec: number
  maskType: string
  piiType: string
  piiDetail?: string
}

/**
 * 단일 PII 구간의 유효성을 검사한다.
 * @returns 에러 메시지 문자열 또는 유효하면 null
 */
export function validatePiiInterval(interval: PiiIntervalInput): string | null {
  if (!Number.isFinite(interval.startSec) || !Number.isFinite(interval.endSec)) {
    return 'Invalid PII interval: startSec and endSec must be finite numbers'
  }
  if (interval.endSec <= interval.startSec) {
    return 'Invalid PII interval: endSec must be greater than startSec'
  }
  if (typeof interval.maskType !== 'string' || typeof interval.piiType !== 'string') {
    return 'Invalid PII interval: maskType and piiType must be strings'
  }
  return null
}

/**
 * PII 구간 배열 전체를 검사한다.
 * @returns 에러 메시지 문자열 또는 모두 유효하면 null
 */
export function validatePiiIntervals(intervals: unknown): string | null {
  if (!Array.isArray(intervals)) {
    return 'piiIntervals must be an array'
  }
  for (const interval of intervals as PiiIntervalInput[]) {
    const error = validatePiiInterval(interval)
    if (error !== null) return error
  }
  return null
}
