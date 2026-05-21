// 창 B setter — 세션을 평가해 sessions.session_dataset_eligible 을 세팅한다.
//
// 오직 이 경로로만 session_dataset_eligible 을 세팅한다(수동 UPDATE 금지).
// 승인 훅(단건/일괄) + 재평가 엔드포인트 + backfill 스크립트가 공유한다.

import { supabaseAdmin } from '../../lib/supabase.js'
import {
  evaluateDatasetEligibility,
  type DatasetEligibilityResult,
} from '../../lib/export/datasetEligibility.js'

// 평가에 필요한 sessions 컬럼만 선택.
const EVAL_SELECT =
  'id, review_status, consent_status, raw_audio_url, utterance_count, duration, ' +
  'session_quality_tier, strategy_locked, lock_reason, dup_status, dup_representative, ' +
  'pii_status, gpu_pii_status, is_pii_cleaned, utterance_upload_status'

export interface SessionEligibilityResult extends DatasetEligibilityResult {
  id: string
}

export interface ApplyDatasetEligibilitySummary {
  evaluated: number
  setTrue: number
  setFalse: number
  results: SessionEligibilityResult[]
}

function toEvalInput(row: Record<string, unknown>) {
  // utterance_upload_status 는 실제 S3 WAV 존재의 cheap proxy(reporting 용).
  // 실제 embedded export 의 WAV 검증은 #14 worker 가 수행. 저장값(eligible)에는 영향 없음.
  const uploadStatus = (row.utterance_upload_status as string | null) ?? null
  const wavPresent = uploadStatus != null && uploadStatus !== 'none'
  return {
    review_status: (row.review_status as string | null) ?? null,
    consent_status: (row.consent_status as string | null) ?? null,
    raw_audio_url: (row.raw_audio_url as string | null) ?? null,
    utterance_count: (row.utterance_count as number | null) ?? null,
    total_duration_sec: (row.duration as number | null) ?? null,
    session_quality_tier: (row.session_quality_tier as string | null) ?? null,
    strategy_locked: (row.strategy_locked as boolean | null) ?? null,
    lock_reason: (row.lock_reason as string | null) ?? null,
    dup_status: (row.dup_status as string | null) ?? null,
    dup_representative: (row.dup_representative as boolean | null) ?? null,
    pii_status: (row.pii_status as string | null) ?? null,
    gpu_pii_status: (row.gpu_pii_status as string | null) ?? null,
    is_pii_cleaned: (row.is_pii_cleaned as boolean | null) ?? null,
    wav_present: wavPresent,
  }
}

/**
 * 주어진 세션들을 평가해 session_dataset_eligible 을 세팅한다.
 * - sessionIds 미지정: review_status='approved' 전체 평가(backfill/재평가).
 * - dryRun: 평가만 하고 DB 변경 없음.
 */
export async function applyDatasetEligibility(
  sessionIds?: string[],
  opts: { dryRun?: boolean } = {},
): Promise<ApplyDatasetEligibilitySummary> {
  let query = supabaseAdmin.from('sessions').select(EVAL_SELECT)
  if (sessionIds && sessionIds.length > 0) {
    query = query.in('id', sessionIds)
  } else {
    query = query.eq('review_status', 'approved')
  }

  const { data, error } = await query
  if (error) throw new Error(`applyDatasetEligibility select failed: ${error.message}`)

  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  const results: SessionEligibilityResult[] = []
  const trueIds: string[] = []
  const falseIds: string[] = []

  for (const row of rows) {
    const id = row.id as string
    const res = evaluateDatasetEligibility(toEvalInput(row))
    results.push({ id, ...res })
    ;(res.eligible ? trueIds : falseIds).push(id)
  }

  if (!opts.dryRun) {
    if (trueIds.length > 0) {
      const { error: upErr } = await supabaseAdmin
        .from('sessions')
        .update({ session_dataset_eligible: true })
        .in('id', trueIds)
      if (upErr) throw new Error(`applyDatasetEligibility update(true) failed: ${upErr.message}`)
    }
    if (falseIds.length > 0) {
      const { error: upErr } = await supabaseAdmin
        .from('sessions')
        .update({ session_dataset_eligible: false })
        .in('id', falseIds)
      if (upErr) throw new Error(`applyDatasetEligibility update(false) failed: ${upErr.message}`)
    }
  }

  return {
    evaluated: rows.length,
    setTrue: trueIds.length,
    setFalse: falseIds.length,
    results,
  }
}
