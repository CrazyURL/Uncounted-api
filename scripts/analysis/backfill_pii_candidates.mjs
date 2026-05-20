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
const VOICE_API_URL = env.VOICE_API_URL || 'http://localhost:8001'
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

  let batch = []
  const flush = async () => {
    if (batch.length === 0) return
    const results = await detectBatch(batch.map((u) => ({ utterance_id: u.id, text: u.transcript_text })))
    const sessionByUtt = new Map(batch.map((u) => [u.id, u.session_id]))

    const rowsToInsert = []
    const utteranceIdsWithCands = []
    for (const r of results) {
      uttProcessed++
      if (!r.candidates || r.candidates.length === 0) continue
      uttWithCandidates++
      totalCandidates += r.candidates.length
      for (const c of r.candidates) {
        tierCounts[c.confidence_tier] = (tierCounts[c.confidence_tier] ?? 0) + 1
        typeCounts[c.type] = (typeCounts[c.type] ?? 0) + 1
      }
      utteranceIdsWithCands.push(r.utterance_id)
      rowsToInsert.push(...toRows(r.utterance_id, sessionByUtt.get(r.utterance_id), r.candidates))
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
  console.log('\n관리자 큐(needs_human_decision) 후보:', tierCounts.needs_human_decision)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
