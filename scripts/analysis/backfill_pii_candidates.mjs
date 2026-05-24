#!/usr/bin/env node
// backfill_pii_candidates.mjs (PII-1A)
//
// 기존 utterances.transcript_text 를 voice-api /api/v1/pii/detect-batch 로 보내
// pii_candidates 후보를 적재한다. 신규 detector 를 만들지 않고 기존 detect_pii_spans 를 재사용한다.
//
// 안전 계약:
//   - 응답/적재 어디에도 원문 PII(matched_text/original_text)를 저장하지 않는다. offset 만.
//   - pii_intervals 는 절대 건드리지 않는다 (PII-3/4 전용).
//
// 사용법 (uncounted-api 디렉토리에서):
//   node scripts/analysis/backfill_pii_candidates.mjs --limit 200   # 샘플
//   node scripts/analysis/backfill_pii_candidates.mjs               # 전체
//   node scripts/analysis/backfill_pii_candidates.mjs --dry-run     # 적재 없이 분포만
//
// 권장 순서: 샘플 200 → 분포/오탐 확인 → 임계값 조정 → 전체.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── env 로드 (uncounted-api/.env) ──────────────────────────────────
const env = {}
for (const line of readFileSync(resolve(process.cwd(), '.env'), 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
// process.env 우선 — .env 미설정 시에도 `VOICE_API_URL=... node ...` 로 비-로컬 voice-api 지정 가능.
const VOICE_API_URL = process.env.VOICE_API_URL || env.VOICE_API_URL || 'http://localhost:8001'
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const limitArg = args.indexOf('--limit')
const LIMIT = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity
const DRY_RUN = args.includes('--dry-run')
const DETECT_BATCH = 50 // detect-batch 한 번에 보낼 발화 수
const MODEL_VERSION = 'detect_spans_bootstrap_v1'

// ── 이름 후보 정밀도 필터 (PII-1A 보강) ─────────────────────────────
// predicted_type='이름' 후보는 호칭/직함 인접일 때만 채택(고정밀 discovery 채널). 비-이름(구조
// PII: 전화/주민/카드/IP 등)은 그대로 통과. 호칭없는 단독 이름은 오탐 대부분이라 드롭.
// ⚠️ 정본(single source of truth) = src/lib/pii/nameHonorificFilter.ts. 토큰 변경 시 양쪽 동기화.
const NAME_PII_TYPE = '이름'
const HONORIFIC_TITLES = ['님', '씨', '매니저', '과장', '차장', '부장', '팀장', '대표', '사장', '이사', '상무', '전무', '회장', '선생', '교수', '박사', '원장', '실장', '대리', '주임', '사원', '국장', '처장', '위원', '총장', '학장', '소장', '반장', '조장', '센터장', '본부장', '지점장', '연구원', '책임', '수석', '전임', '감독', '코치', '기사', '고객']
const NAME_STOPWORDS = new Set(['안녕하', '감사합', '죄송합', '말씀드', '그러니', '그래서', '그러면', '하니까'])
// 관계/지위 호칭(이름부가 이 집합이면 드롭 — '장모님' 류 오탐 제거). 직함계는 불변.
const KINSHIP_NONNAME = new Set(['장모', '사모', '시모', '빙모', '빙장', '처남', '처제', '형수', '제수', '형부', '매부', '동서', '시누', '올케', '며느리', '사돈', '사부', '은사', '선배', '후배', '형', '누', '아우'])
// 호칭 부분문자열과 충돌하는 비-이름 합성명사(정확 일치 드롭).
const NAME_FULL_DENYLIST = new Set(['주차장', '세차장'])
function isHonorificAdjacentName(text, s, e) {
  if (!text || s == null || e == null || e <= s || s < 0 || e > text.length) return false
  const span = text.slice(s, e)
  if (NAME_STOPWORDS.has(span)) return false
  if (NAME_FULL_DENYLIST.has(span)) return false
  let i = e
  while (i < text.length && /\s/.test(text[i])) i++
  const w = text.slice(i, i + 6)
  if (HONORIFIC_TITLES.some((t) => w.startsWith(t))) return !KINSHIP_NONNAME.has(span)
  for (const t of HONORIFIC_TITLES) {
    if (span.length > t.length && span.endsWith(t)) return !KINSHIP_NONNAME.has(span.slice(0, span.length - t.length))
  }
  return false
}
function filterNameCandidates(candidates, text) {
  return (candidates || []).filter((c) => c.type !== NAME_PII_TYPE || isHonorificAdjacentName(text, c.char_start, c.char_end))
}

// ── voice-api detect-batch 호출 (candidateService 와 동일 계약) ─────
async function detectBatch(items) {
  const res = await fetch(`${VOICE_API_URL}/api/v1/pii/detect-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, enable_name_masking: true }),
  })
  if (!res.ok) {
    throw new Error(`detect-batch failed (${res.status}): ${await res.text()}`)
  }
  const body = await res.json()
  return body.results ?? []
}

// 후보 → pii_candidates 행 (원문 키 없음).
function toRows(utteranceId, sessionId, candidates) {
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
    model_version: MODEL_VERSION,
    status: 'pending',
  }))
}

async function* pageUtterances() {
  const PAGE = 500
  let from = 0
  let fetched = 0
  while (fetched < LIMIT) {
    const { data, error } = await supabase
      .from('utterances')
      .select('id, session_id, transcript_text')
      .not('transcript_text', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    for (const row of data) {
      if (fetched >= LIMIT) break
      if (row.transcript_text && row.transcript_text.trim()) {
        yield row
        fetched++
      }
    }
    if (data.length < PAGE) break
    from += PAGE
  }
}

async function main() {
  const tierCounts = { auto_confirmed: 0, needs_human_decision: 0, auto_rejected: 0 }
  const typeCounts = {}
  let uttProcessed = 0
  let uttWithCandidates = 0
  let totalCandidates = 0
  let inserted = 0
  let nameRawSeen = 0 // detect-batch 가 준 이름 후보(필터 전)
  let nameKept = 0 // 호칭 필터 통과한 이름 후보

  let batch = []
  const flush = async () => {
    if (batch.length === 0) return
    const results = await detectBatch(batch.map((u) => ({ utterance_id: u.id, text: u.transcript_text })))
    const sessionByUtt = new Map(batch.map((u) => [u.id, u.session_id]))
    const textByUtt = new Map(batch.map((u) => [u.id, u.transcript_text]))

    const rowsToInsert = []
    const utteranceIdsWithCands = []
    for (const r of results) {
      uttProcessed++
      const raw = r.candidates || []
      nameRawSeen += raw.filter((c) => c.type === NAME_PII_TYPE).length
      // 정밀도 필터: 이름 후보는 호칭/직함 인접만 채택. 구조 PII 는 통과.
      const cands = filterNameCandidates(raw, textByUtt.get(r.utterance_id) || '')
      nameKept += cands.filter((c) => c.type === NAME_PII_TYPE).length
      if (cands.length === 0) continue
      uttWithCandidates++
      totalCandidates += cands.length
      for (const c of cands) {
        tierCounts[c.confidence_tier] = (tierCounts[c.confidence_tier] ?? 0) + 1
        typeCounts[c.type] = (typeCounts[c.type] ?? 0) + 1
      }
      utteranceIdsWithCands.push(r.utterance_id)
      rowsToInsert.push(...toRows(r.utterance_id, sessionByUtt.get(r.utterance_id), cands))
    }

    if (!DRY_RUN && rowsToInsert.length > 0) {
      // 재실행 idempotency: 아직 판정 안 된(pending+미결정) 후보만 삭제 후 재삽입.
      // 관리자 판정(admin_decision)이 있는 후보는 보존 — PII-1B 안전.
      await supabase
        .from('pii_candidates')
        .delete()
        .in('utterance_id', utteranceIdsWithCands)
        .eq('status', 'pending')
        .is('admin_decision', null)
      const { error: insErr, count } = await supabase
        .from('pii_candidates')
        .insert(rowsToInsert, { count: 'exact' })
      if (insErr) throw insErr
      inserted += count ?? rowsToInsert.length
    }
    batch = []
  }

  for await (const utt of pageUtterances()) {
    batch.push(utt)
    if (batch.length >= DETECT_BATCH) await flush()
  }
  await flush()

  // ── 분포 보고 ─────────────────────────────────────────────────────
  console.log('\n===== PII 후보 backfill 결과 =====')
  console.log(`mode: ${DRY_RUN ? 'DRY-RUN (적재 없음)' : '적재'}  limit: ${LIMIT === Infinity ? '전체' : LIMIT}`)
  console.log(`발화 처리: ${uttProcessed}  후보 보유 발화: ${uttWithCandidates}  총 후보: ${totalCandidates}  적재: ${inserted}`)
  console.log('\n[confidence_tier 분포]')
  for (const [k, v] of Object.entries(tierCounts)) console.log(`  ${k.padEnd(22)} ${v}`)
  console.log('\n[predicted_type 분포]')
  for (const [k, v] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${v}`)
  }
  console.log('\n[이름 후보 정밀도 필터]')
  console.log(`  raw 이름 후보(필터 전): ${nameRawSeen}  →  호칭 동반 채택: ${nameKept}  (드롭 ${nameRawSeen - nameKept})`)
  console.log('\n관리자 큐(needs_human_decision) 후보:', tierCounts.needs_human_decision)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
