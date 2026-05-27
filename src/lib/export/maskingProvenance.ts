// PII 마스킹 provenance — pii_meta.maskingMethod 를 pii_intervals 의 maskType 분포에서
// 실제 적용분만 정직하게 산출한다(text_only 패키지가 audio_beep_1khz 로 오표기되는 것 방지).
// 순수 함수만 — supabase/S3 등 부수효과 의존 없음(독립 단위 테스트 가능).

/**
 * utterances[].pii_intervals 의 maskType 값 분포를 센다.
 * 음향/텍스트 해석 없이 raw 카운트만 — provenance 투명성용.
 */
export function collectMaskTypeDistribution(
  utterances: ReadonlyArray<Record<string, unknown>>,
): Record<string, number> {
  const dist: Record<string, number> = {}
  for (const utt of utterances) {
    const intervals = utt.pii_intervals
    if (!Array.isArray(intervals)) continue
    for (const iv of intervals) {
      if (!iv || typeof iv !== 'object') continue
      const mt = (iv as Record<string, unknown>).maskType
      if (typeof mt === 'string' && mt.length > 0) {
        dist[mt] = (dist[mt] ?? 0) + 1
      }
    }
  }
  return dist
}

/**
 * maskType 분포에서 **실제 적용된** 마스킹 방법 문자열을 산출한다(거짓 음향 주장 방지).
 *
 * 규칙:
 *  - `beep`/`audio_beep_1khz`/`audio`(legacy alias) → `audio_beep_1khz` (음향 비프 실재)
 *  - `silence`/`audio_silence` → `audio_silence` (음향 무음 실재)
 *  - `text_only`/그 외 → 음향 토큰 미추가(텍스트만)
 *  - 텍스트 토큰 치환은 패키지 transcript 가 마스킹된 형태로 수록되므로 항상 `text_substitute` 포함.
 *
 * 결과적으로 text_only 만 있는 패키지는 `text_substitute` 만, 비프가 실재할 때만
 * `audio_beep_1khz + text_substitute` 를 표기한다(mixed 패키지도 실재 토큰만 — 과장 없음).
 * 무결성 보증 표현이 아니다.
 */
export function deriveMaskingMethod(maskTypes: Iterable<string>): string {
  const audio = new Set<string>()
  for (const mt of maskTypes) {
    switch (mt) {
      case 'beep':
      case 'audio_beep_1khz':
      case 'audio': // legacy alias(현 live writer 없음, 과거 행 방어용)
        audio.add('audio_beep_1khz')
        break
      case 'silence':
      case 'audio_silence':
        audio.add('audio_silence')
        break
      default:
        // text_only / unknown → 음향 변형 아님, 음향 토큰 미추가
        break
    }
  }
  return [...[...audio].sort(), 'text_substitute'].join(' + ')
}
