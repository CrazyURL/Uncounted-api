// ── IVR(대표번호) 판별 ──────────────────────────────────────────────────────
// 상대가 사람이 아닌 자동응답(IVR) 통화는 양측 동의 없이 업로드 가능(상대 동의 대상 부재).
// 개인 통화는 양측 동의된 것만 업로드 → ingest(동의 없는 자동 업로드)는 IVR 만 허용.
//
// 패턴(사용자 확정 2026-06-12): "1로 시작 8자리(15XX/16XX/18XX 등 전국대표번호) + 080(수신자부담)".
// 휴대폰(01X)·집전화(02/0XX)는 0으로 시작해 자동 제외.

export function normalizeNumber(raw: string | undefined | null): string {
  if (!raw) return ''
  let d = raw.replace(/[^0-9]/g, '')
  if (d.startsWith('82')) d = '0' + d.slice(2) // +82 국가코드 → 0
  return d
}

export function isIvrNumber(raw: string | undefined | null): boolean {
  const d = normalizeNumber(raw)
  if (!d) return false
  return /^1\d{7}$/.test(d) || /^080\d+/.test(d)
}
