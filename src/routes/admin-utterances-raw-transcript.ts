// ── Admin 단일 발화 원문 전사 조회 API (PR-P2B-A) ──────────────────────
// 목적: 관리자 수동 PII span 등록 UI(PR-P2B-B) 전용.
//   raw transcript_text 기준 char offset 을 정확히 산출하려면 마스킹/절단 전 원문이
//   필요하다. 표시용 utterance.text 는 maskKnownNames + slice(0,200) 가 적용돼
//   (admin-utterances-v2.ts:99) offset 이 서버 저장 기준(raw)과 어긋나기 때문이다.
//   서버 POST /pii-annotations 는 raw transcript_text[char_start:char_end] 에서 hash 를
//   산출하므로, UI 도 동일한 raw 텍스트 위에서 offset 을 계산해야 한다.
//
// 안전 계약 (강제):
//   - admin 전용. 단일 utterance 1건만. read-only.
//   - 응답에 transcript_text 외 민감 필드 미부착(후보/라벨/오디오 경로 없음).
//   - 응답 바디는 devBodyLogger 로깅에서 제외된다(shouldSkipBodyLog) — console/log 미출력.
//   - Cache-Control: no-store — 프록시/CDN(Cloudflare Tunnel)/브라우저 캐시 금지.
//   - 외부 export / bulk 조회와 무관. transcript list raw 반환 경로 아님.
//   - length = transcript_text.length (UTF-16 code unit). admin UI 의 char_start/char_end 는
//     동일 단위(DOM Selection offset 기본)로 산출해야 서버 extractSpan(slice) 과 일치한다.

import { Hono } from 'hono'
import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware } from '../lib/middleware.js'

const adminUtterancesRawTranscript = new Hono()

// 정확히 이 경로에만 인증/어드민 게이트 적용(다른 /api/admin/* 라우트에 중복 적용 방지).
adminUtterancesRawTranscript.use('/utterances/:id/raw-transcript', authMiddleware)
adminUtterancesRawTranscript.use('/utterances/:id/raw-transcript', adminMiddleware)

// ── GET /api/admin/utterances/:id/raw-transcript ──────────────────────
adminUtterancesRawTranscript.get('/utterances/:id/raw-transcript', async (c) => {
  const id = c.req.param('id')

  const { data, error } = await supabaseAdmin
    .from('utterances')
    .select('id, session_id, transcript_text')
    .eq('id', id)
    .single()

  if (error || !data) {
    return c.json({ error: 'utterance not found' }, 404)
  }

  const row = data as { id: string; session_id: string; transcript_text: string | null }
  const text = row.transcript_text ?? ''

  // 캐시 금지 — 원문 전사가 프록시/CDN/브라우저 캐시에 잔존하지 않도록.
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  c.header('Pragma', 'no-cache')

  return c.json({
    success: true,
    data: {
      utterance_id: row.id,
      session_id: row.session_id,
      transcript_text: text,
      length: text.length,
    },
  })
})

export default adminUtterancesRawTranscript
