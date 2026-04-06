// ── bu_quality_metrics CRUD ─────────────────────────────────────────────
import { supabaseAdmin } from '../supabase.js'

export interface BuQualityMetricsRow {
  id: string
  session_id: string
  bu_index: number
  user_id: string
  snr_db: number | null
  speech_ratio: number | null
  clipping_ratio: number | null
  beep_mask_ratio: number | null
  volume_lufs: number | null
  quality_score: number | null
  quality_grade: string | null
  analyzed_at: string
}

export interface BuQualityMetricsInsert {
  session_id: string
  bu_index: number
  user_id: string
  snr_db?: number | null
  speech_ratio?: number | null
  clipping_ratio?: number | null
  beep_mask_ratio?: number | null
  volume_lufs?: number | null
  quality_score?: number | null
  quality_grade?: string | null
}

/** Upsert a single quality metrics row (UNIQUE on session_id + bu_index) */
export async function upsertQualityMetrics(
  row: BuQualityMetricsInsert,
): Promise<BuQualityMetricsRow> {
  const { data, error } = await supabaseAdmin
    .from('bu_quality_metrics')
    .upsert(
      { ...row, analyzed_at: new Date().toISOString() },
      { onConflict: 'session_id,bu_index' },
    )
    .select()
    .single()

  if (error) {
    throw new Error(`upsertQualityMetrics failed: ${error.message}`)
  }
  return data as BuQualityMetricsRow
}

/** Upsert multiple quality metrics rows in batch */
export async function upsertQualityMetricsBatch(
  rows: BuQualityMetricsInsert[],
): Promise<BuQualityMetricsRow[]> {
  if (rows.length === 0) return []

  const now = new Date().toISOString()
  const withTimestamp = rows.map((r) => ({ ...r, analyzed_at: now }))

  const { data, error } = await supabaseAdmin
    .from('bu_quality_metrics')
    .upsert(withTimestamp, { onConflict: 'session_id,bu_index' })
    .select()

  if (error) {
    throw new Error(`upsertQualityMetricsBatch failed: ${error.message}`)
  }
  return (data ?? []) as BuQualityMetricsRow[]
}

/** Get quality metrics for a session */
export async function getQualityMetricsBySession(
  sessionId: string,
): Promise<BuQualityMetricsRow[]> {
  const { data, error } = await supabaseAdmin
    .from('bu_quality_metrics')
    .select('*')
    .eq('session_id', sessionId)
    .order('bu_index', { ascending: true })

  if (error) {
    throw new Error(`getQualityMetricsBySession failed: ${error.message}`)
  }
  return (data ?? []) as BuQualityMetricsRow[]
}

/** Get quality metrics for multiple sessions */
export async function getQualityMetricsBySessions(
  sessionIds: string[],
): Promise<BuQualityMetricsRow[]> {
  if (sessionIds.length === 0) return []

  const { data, error } = await supabaseAdmin
    .from('bu_quality_metrics')
    .select('*')
    .in('session_id', sessionIds)
    .order('session_id')
    .order('bu_index', { ascending: true })

  if (error) {
    throw new Error(`getQualityMetricsBySessions failed: ${error.message}`)
  }
  return (data ?? []) as BuQualityMetricsRow[]
}

/** Delete quality metrics for a session */
export async function deleteQualityMetricsBySession(
  sessionId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('bu_quality_metrics')
    .delete()
    .eq('session_id', sessionId)

  if (error) {
    throw new Error(`deleteQualityMetricsBySession failed: ${error.message}`)
  }
}
