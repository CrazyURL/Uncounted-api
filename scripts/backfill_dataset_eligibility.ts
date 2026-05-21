// 창 B backfill — 기존 approved 세션의 session_dataset_eligible 일괄 평가/세팅.
//
// 기본 dry-run(평가만, DB 변경 없음). --apply 플래그 시에만 세팅.
// 평가 로직은 applyDatasetEligibility(=evaluateDatasetEligibility) 재사용 — 드리프트 없음.
//
// 실행:
//   npx tsx scripts/backfill_dataset_eligibility.ts            # dry-run
//   npx tsx scripts/backfill_dataset_eligibility.ts --apply    # 실제 세팅

import 'dotenv/config'
import { applyDatasetEligibility } from '../src/services/export/applyDatasetEligibility.js'

async function main() {
  const apply = process.argv.includes('--apply')
  const dryRun = !apply

  console.log(`[backfill] dataset eligibility — mode: ${dryRun ? 'DRY-RUN (no writes)' : 'APPLY (writes)'}`)
  const summary = await applyDatasetEligibility(undefined, { dryRun })

  console.log(`[backfill] evaluated approved sessions: ${summary.evaluated}`)
  console.log(`[backfill] eligible (true): ${summary.setTrue} | ineligible (false): ${summary.setFalse}`)

  // 차단 사유 분포
  const reasonCounts: Record<string, number> = {}
  for (const r of summary.results) {
    for (const reason of r.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
  }
  if (Object.keys(reasonCounts).length > 0) {
    console.log('[backfill] block reason distribution:', JSON.stringify(reasonCounts))
  }

  // 샘플 출력
  for (const r of summary.results.slice(0, 5)) {
    console.log(
      `  ${r.id} eligible=${r.eligible} ref_ready=${r.exportModes.reference_only.ready} ` +
        `emb_ready=${r.exportModes.embedded.ready} reasons=${JSON.stringify(r.reasons)} warnings=${JSON.stringify(r.warnings)}`,
    )
  }

  if (dryRun) console.log('[backfill] DRY-RUN: no DB changes. re-run with --apply to set session_dataset_eligible.')
  else console.log('[backfill] APPLY complete.')
}

main().catch((err) => {
  console.error('[backfill] FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
