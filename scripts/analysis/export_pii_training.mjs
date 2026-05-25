#!/usr/bin/env node
// PR-P2D: PII 학습/평가용 라벨 export (read-only, 원문 미포함).
//
// 마스킹 실행이 아니라 라벨 데이터 추출이다. DB write 없음 — GET 만 수행.
// 안전 계약(기본 모드):
//   - transcript_text / matched_text / snippet / selected_text 를 절대 export 하지 않는다.
//   - offset(char_start/char_end) + normalized_text_hash + type 만 사용.
//   - 원문 포함 학습셋은 별도 승인 후 별도 모드(미구현)로만.
//
// 출력(data/pii_training/):
//   - pii_positive_annotations.jsonl   (pii_annotations: source∈detector_candidate/admin_manual, action_status∈pending_mask/masked)
//   - pii_negative_candidates.jsonl     (pii_candidates: admin_decision='rejected', status='decided')
//   - pii_skipped_candidates.jsonl      (pii_candidates: admin_decision='skipped' — 학습 기본 미포함)
//   - pii_export_report_YYYYMMDD.md     (count/type/status/source 분포만)
//
// 사용법 (uncounted-api 디렉토리에서):
//   node scripts/analysis/export_pii_training.mjs --dry-run   # 파일 미생성, 분포만
//   node scripts/analysis/export_pii_training.mjs             # JSONL+report 생성

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const env = {}
for (const line of readFileSync(resolve(process.cwd(), '.env'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env')
  process.exit(1)
}
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
const DRY_RUN = process.argv.includes('--dry-run')

// 원문 계열 키 — export 행에 들어오면 즉시 중단(안전 가드).
const FORBIDDEN_KEYS = ['transcript_text', 'matched_text', 'snippet', 'candidate_text', 'selected_text', 'context_before', 'context_after', 'text']
function assertNoRaw(row, where) {
  for (const k of Object.keys(row)) {
    if (FORBIDDEN_KEYS.includes(k)) {
      throw new Error(`FORBIDDEN raw field '${k}' in ${where} — aborting (안전 위반)`)
    }
  }
}

async function fetchAll(path) {
  const out = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { ...H, Range: `${from}-${from + PAGE - 1}` } })
    if (!r.ok) throw new Error(`fetch failed ${r.status}: ${await r.text()}`)
    const rows = await r.json()
    if (!Array.isArray(rows) || rows.length === 0) break
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

function dist(rows, key) {
  const d = {}
  for (const r of rows) d[r[key] ?? 'null'] = (d[r[key] ?? 'null'] || 0) + 1
  return d
}

// ── A. Positive (pii_annotations) ───────────────────────────────────
const POS_SELECT = 'id,utterance_id,session_id,source,candidate_id,pii_type,char_start,char_end,normalized_text_hash,action_status,reviewed_by,reviewed_at'
const posRaw = await fetchAll(
  `pii_annotations?source=in.(detector_candidate,admin_manual)&action_status=in.(pending_mask,masked)&select=${POS_SELECT}&order=reviewed_at.asc`,
)
const positive = posRaw.map((r) => {
  const row = {
    annotation_id: r.id,
    utterance_id: r.utterance_id,
    session_id: r.session_id,
    source: r.source,
    candidate_id: r.candidate_id,
    pii_type: r.pii_type,
    char_start: r.char_start,
    char_end: r.char_end,
    normalized_text_hash: r.normalized_text_hash,
    action_status: r.action_status,
    reviewed_by: r.reviewed_by,
    reviewed_at: r.reviewed_at,
    label: 'positive',
  }
  assertNoRaw(row, 'positive')
  return row
})

// ── B. Negative (pii_candidates rejected) ───────────────────────────
const NEG_SELECT = 'id,utterance_id,session_id,predicted_type,char_start,char_end,confidence,confidence_tier,admin_decision,reviewed_by,decided_at'
const negRaw = await fetchAll(
  `pii_candidates?admin_decision=eq.rejected&status=eq.decided&select=${NEG_SELECT}&order=decided_at.asc`,
)
const negative = negRaw.map((r) => {
  const row = {
    candidate_id: r.id,
    utterance_id: r.utterance_id,
    session_id: r.session_id,
    predicted_type: r.predicted_type,
    char_start: r.char_start,
    char_end: r.char_end,
    confidence: r.confidence,
    confidence_tier: r.confidence_tier,
    admin_decision: r.admin_decision,
    reviewed_by: r.reviewed_by,
    decided_at: r.decided_at,
    label: 'negative',
  }
  assertNoRaw(row, 'negative')
  return row
})

// ── C. Skipped (pii_candidates skipped) ─────────────────────────────
const skipRaw = await fetchAll(
  `pii_candidates?admin_decision=eq.skipped&select=${NEG_SELECT},status&order=decided_at.asc`,
)
const skipped = skipRaw.map((r) => {
  const row = {
    candidate_id: r.id,
    utterance_id: r.utterance_id,
    session_id: r.session_id,
    predicted_type: r.predicted_type,
    char_start: r.char_start,
    char_end: r.char_end,
    confidence: r.confidence,
    confidence_tier: r.confidence_tier,
    admin_decision: r.admin_decision,
    status: r.status,
    reviewed_by: r.reviewed_by,
    decided_at: r.decided_at,
    label: 'skipped',
  }
  assertNoRaw(row, 'skipped')
  return row
})

// ── 분포 ─────────────────────────────────────────────────────────────
const report = {
  positive: { count: positive.length, by_pii_type: dist(positive, 'pii_type'), by_source: dist(positive, 'source'), by_action_status: dist(positive, 'action_status') },
  negative: { count: negative.length, by_predicted_type: dist(negative, 'predicted_type'), by_confidence_tier: dist(negative, 'confidence_tier') },
  skipped: { count: skipped.length, by_predicted_type: dist(skipped, 'predicted_type') },
}

console.log('===== PII training export (read-only, 원문 미포함) =====')
console.log('mode:', DRY_RUN ? 'DRY-RUN (파일 미생성)' : '파일 생성')
console.log('positive(pii_annotations):', report.positive.count, JSON.stringify(report.positive.by_pii_type), 'source', JSON.stringify(report.positive.by_source))
console.log('negative(rejected candidates):', report.negative.count, JSON.stringify(report.negative.by_predicted_type))
console.log('skipped(candidates):', report.skipped.count, JSON.stringify(report.skipped.by_predicted_type))
console.log('원문 필드 가드: FORBIDDEN_KEYS', FORBIDDEN_KEYS.length, '종 검사 통과(예외 없음 = 원문 미포함)')

if (DRY_RUN) {
  console.log('DRY-RUN: 파일 미생성. DB write 0.')
  process.exit(0)
}

// ── 파일 생성 ────────────────────────────────────────────────────────
const OUT = resolve(process.cwd(), 'data/pii_training')
mkdirSync(OUT, { recursive: true })
const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
writeFileSync(resolve(OUT, 'pii_positive_annotations.jsonl'), toJsonl(positive))
writeFileSync(resolve(OUT, 'pii_negative_candidates.jsonl'), toJsonl(negative))
writeFileSync(resolve(OUT, 'pii_skipped_candidates.jsonl'), toJsonl(skipped))

const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const md = `# PII training export report — ${new Date().toISOString()}

> read-only. DB write 0. 원문(transcript_text/matched_text/snippet) 미포함 — offset+hash+type 만.

## Positive (pii_annotations, source∈detector_candidate/admin_manual, action_status∈pending_mask/masked)
- count: ${report.positive.count}
- pii_type: ${JSON.stringify(report.positive.by_pii_type)}
- source: ${JSON.stringify(report.positive.by_source)}
- action_status: ${JSON.stringify(report.positive.by_action_status)}

## Negative (pii_candidates, admin_decision='rejected', status='decided')
- count: ${report.negative.count}
- predicted_type: ${JSON.stringify(report.negative.by_predicted_type)}
- confidence_tier: ${JSON.stringify(report.negative.by_confidence_tier)}

## Skipped (pii_candidates, admin_decision='skipped' — 학습 기본 미포함)
- count: ${report.skipped.count}
- predicted_type: ${JSON.stringify(report.skipped.by_predicted_type)}

## 파일
- data/pii_training/pii_positive_annotations.jsonl
- data/pii_training/pii_negative_candidates.jsonl
- data/pii_training/pii_skipped_candidates.jsonl
`
writeFileSync(resolve(OUT, `pii_export_report_${ymd}.md`), md)
console.log('생성:', OUT)
