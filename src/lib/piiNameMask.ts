// ── 알려진 실명 표시-시점 마스킹 (Track 0 응급 PII) ─────────────────────────
//
// 목적: 전사 텍스트(transcript_text)에 노출된 실명을 화면/내보내기 직전에 마스킹.
//   - denylist 는 PII_NAME_DENYLIST env (콤마구분) 로만 주입 — 실명 소스 하드코딩 금지.
//   - 비파괴: DB 의 transcript_text 는 변형하지 않는다. env 비우면 즉시 no-op 원복.
//   - 띄어쓰기 변형("문 식환")도 매칭하도록 글자 사이 공백 허용 정규식 사용.
//   - 이름만 치환하고 접미("소장님/님/씨")는 보존 → "OOO 소장님" → "[이름] 소장님".
//   - 한글 정규화: denylist·입력 텍스트 양쪽 NFC 정규화 → 조합형(NFD) 전사도 매칭(시각 동일·코드포인트 상이 무매칭 방지).
//   - env 견고화: 항목별 앞뒤 따옴표 trim(Render 등에서 값에 따옴표가 섞여도 토큰 오염 방지).
//
// 텍스트 마스킹은 기존 시스템에 컨벤션이 없어 본 토큰을 신규 확정한다.

export const NAME_MASK_TOKEN = '[이름]'

/**
 * 콤마구분 denylist 문자열을 trim·공백제거·중복제거하여 배열로 파싱한다.
 * 운영 기본값은 process.env.PII_NAME_DENYLIST.
 */
export function parseNameDenylist(
  raw: string | undefined = process.env.PII_NAME_DENYLIST,
): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(',')) {
    // 공백 제거 → 앞뒤 따옴표(" ') trim → NFC 정규화.
    const name = part
      .replace(/\s+/g, '')
      .replace(/^["']+|["']+$/g, '')
      .normalize('NFC')
    if (name.length === 0) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 이름 글자 사이에 임의 공백을 허용하는 정규식 (띄어쓰기 변형 대응). */
function buildNamePattern(name: string): RegExp {
  const chars = Array.from(name).map(escapeRegex)
  return new RegExp(chars.join('\\s*'), 'g')
}

/**
 * 텍스트 내 denylist 실명을 NAME_MASK_TOKEN 으로 치환한다.
 *
 * @param text 원본 전사 텍스트
 * @param names denylist (생략 시 PII_NAME_DENYLIST env 파싱)
 * @returns 마스킹된 텍스트. text 가 비거나 names 가 비면 원본 그대로(no-op).
 *          마스킹 활성 시 반환 텍스트는 NFC 정규형(매칭 일관성 — 시각상 동일).
 */
export function maskKnownNames(
  text: string,
  names: readonly string[] = parseNameDenylist(),
): string {
  if (!text || names.length === 0) return text
  // NFC 정규화 — denylist(NFC)와 코드포인트 정합. names 가 직접 전달돼도 안전하게 재정규화.
  let out = text.normalize('NFC')
  const normalized = names.map((n) => n.normalize('NFC')).filter((n) => n.length > 0)
  // 긴 이름 우선 — 부분 겹침 방지.
  const sorted = [...normalized].sort((a, b) => b.length - a.length)
  for (const name of sorted) {
    out = out.replace(buildNamePattern(name), NAME_MASK_TOKEN)
  }
  return out
}
