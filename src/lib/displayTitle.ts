// ── displayTitle — admin 응답에서 통화 식별용 합성 라벨 ─────────────────────
// STAGE 6.
//
// 형식: "통화#{seq:06} · {YYYY-MM-DD} · {duration}"
//   예) "통화#000042 · 2026-05-02 · 30초"
//       "통화#000041 · 2026-04-30 · 2분12초"
//       "통화#000040 · 2026-04-09 · 11분07초"
//
// 정책:
//   - admin 모든 응답은 raw title 대신 이 함수 결과 반환
//   - title 컬럼은 백엔드 내부(검색 매칭)에만 사용, 응답 select 절 X
//   - seq null 시 fallback "통화#????" (백필 누락 방어)

export function formatDisplayTitle(
  seq: number | null | undefined,
  createdAt: string | Date | null | undefined,
  durationSec: number | null | undefined,
): string {
  if (seq == null) return '통화#????'
  const seqStr = String(seq).padStart(6, '0')

  let dateStr = '????-??-??'
  if (createdAt) {
    const iso = typeof createdAt === 'string' ? createdAt : createdAt.toISOString()
    dateStr = iso.slice(0, 10)
  }

  const dur = formatDurationKo(durationSec ?? 0)
  return `통화#${seqStr} · ${dateStr} · ${dur}`
}

function formatDurationKo(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0초'
  if (sec < 60) return `${Math.round(sec)}초`
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  if (s === 0) return `${m}분`
  return `${m}분${String(s).padStart(2, '0')}초`
}
