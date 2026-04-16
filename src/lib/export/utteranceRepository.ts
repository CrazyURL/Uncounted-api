// ── Utterance metadata CRUD (export_package_items) ─────────────────────
// utterance 메타데이터를 export_package_items 테이블에 저장/조회/갱신

import { supabaseAdmin, fetchAllPaginated } from '../supabase.js'

export interface UtteranceItem {
  id: string
  export_request_id: string
  session_id: string | null
  bu_id: string | null
  utterance_id: string
  user_id: string | null
  pseudo_id: string | null
  file_path_in_package: string
  file_type: string
  file_size_bytes: number | null
  quality_grade: string | null
  qa_score: number | null
  snr_db: number | null
  speech_ratio: number | null
  duration_sec: number | null
  has_context_labels: boolean
  has_dialog_labels: boolean
  content_hash: string | null
  created_at: string
}

export interface UtteranceSaveInput {
  utteranceId: string
  sessionId: string
  buId?: string | null
  userId?: string | null
  pseudoId?: string | null
  filePathInPackage: string
  fileSizeBytes?: number | null
  qualityGrade?: string | null
  qaScore?: number | null
  snrDb?: number | null
  speechRatio?: number | null
  durationSec: number
  hasContextLabels?: boolean
  hasDialogLabels?: boolean
  contentHash?: string | null
}

/**
 * utterance_id 생성: utt_{sessionId}_{3자리 인덱스}
 */
export function buildUtteranceId(sessionId: string, index: number): string {
  return `utt_${sessionId}_${String(index).padStart(3, '0')}`
}

/**
 * Save utterances to export_package_items
 */
export async function saveUtterances(
  exportRequestId: string,
  utterances: UtteranceSaveInput[],
): Promise<UtteranceItem[]> {
  if (utterances.length === 0) return []

  const rows = utterances.map((u) => ({
    export_request_id: exportRequestId,
    session_id: u.sessionId,
    bu_id: u.buId ?? null,
    utterance_id: u.utteranceId,
    user_id: u.userId ?? null,
    pseudo_id: u.pseudoId ?? null,
    file_path_in_package: u.filePathInPackage,
    file_type: 'wav' as const,
    file_size_bytes: u.fileSizeBytes ?? null,
    quality_grade: u.qualityGrade ?? null,
    qa_score: u.qaScore ?? null,
    snr_db: u.snrDb ?? null,
    speech_ratio: u.speechRatio ?? null,
    duration_sec: u.durationSec,
    has_context_labels: u.hasContextLabels ?? false,
    has_dialog_labels: u.hasDialogLabels ?? false,
    content_hash: u.contentHash ?? null,
  }))

  const BATCH = 500
  const all: UtteranceItem[] = []

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const { data, error } = await supabaseAdmin
      .from('export_package_items')
      .upsert(batch, { onConflict: 'id' })
      .select()

    if (error) {
      throw new Error(`saveUtterances failed: ${error.message}`)
    }
    all.push(...((data ?? []) as UtteranceItem[]))
  }

  return all
}

/**
 * Get all utterances for an export request, ordered by utterance_id.
 * 페이지네이션으로 1000행 초과에도 전체 수집.
 */
export async function getUtterancesByExportRequest(
  exportRequestId: string,
): Promise<UtteranceItem[]> {
  return fetchAllPaginated<UtteranceItem>(() =>
    supabaseAdmin
      .from('export_package_items')
      .select('*')
      .eq('export_request_id', exportRequestId)
      .eq('file_type', 'wav')
      .order('utterance_id', { ascending: true }),
  )
}

/**
 * Update utterance inclusion status.
 * If excluded, sets file_path_in_package to indicate exclusion reason.
 */
export async function updateUtteranceStatus(
  utteranceItemId: string,
  isIncluded: boolean,
  excludeReason?: string,
): Promise<void> {
  const updateFields: Record<string, unknown> = {}

  if (!isIncluded && excludeReason) {
    updateFields.content_hash = `excluded:${excludeReason}`
  } else if (isIncluded) {
    updateFields.content_hash = null
  }

  const { error } = await supabaseAdmin
    .from('export_package_items')
    .update(updateFields)
    .eq('utterance_id', utteranceItemId)

  if (error) {
    throw new Error(`updateUtteranceStatus failed: ${error.message}`)
  }
}

/**
 * Delete all utterance items for an export request
 */
export async function deleteUtterancesByExportRequest(
  exportRequestId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('export_package_items')
    .delete()
    .eq('export_request_id', exportRequestId)
    .eq('file_type', 'wav')

  if (error) {
    throw new Error(`deleteUtterancesByExportRequest failed: ${error.message}`)
  }
}

/**
 * Count active (non-excluded) utterances for an export request
 */
export async function countActiveUtterances(
  exportRequestId: string,
): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('export_package_items')
    .select('*', { count: 'exact', head: true })
    .eq('export_request_id', exportRequestId)
    .eq('file_type', 'wav')
    .is('content_hash', null)

  if (error) {
    throw new Error(`countActiveUtterances failed: ${error.message}`)
  }
  return count ?? 0
}
