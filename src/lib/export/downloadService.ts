// ── Download Service ───────────────────────────────────────────────────
// Export 패키지 다운로드 URL 생성 및 export_jobs 업데이트

import { supabaseAdmin } from '../supabase.js'
import { getSignedUrl, S3_AUDIO_BUCKET } from '../s3.js'

const DOWNLOAD_EXPIRES_SEC = 24 * 60 * 60 // 24시간

/**
 * Generate a signed download URL for an export package.
 * Updates export_jobs with the URL and expiry time.
 */
export async function getSignedDownloadUrl(
  exportJobId: string,
): Promise<{ downloadUrl: string; expiresAt: string }> {
  // Verify job exists and has a package
  const { data: job, error: fetchError } = await supabaseAdmin
    .from('export_jobs')
    .select('package_storage_path, status, sku_id, created_at')
    .eq('id', exportJobId)
    .single()

  if (fetchError || !job) {
    throw new Error(`Export job not found: ${exportJobId}`)
  }

  if (!job.package_storage_path) {
    throw new Error(`Export job ${exportJobId} has no package yet`)
  }

  // Build a human-readable filename: export_{skuId}_{date}.zip
  const dateStr = new Date(job.created_at).toISOString().slice(0, 10)
  const filename = `export_${job.sku_id}_${dateStr}.zip`

  // Generate signed URL using the actual stored path (24h)
  const downloadUrl = await getSignedUrl(S3_AUDIO_BUCKET, job.package_storage_path, DOWNLOAD_EXPIRES_SEC, filename)
  const expiresAt = new Date(Date.now() + DOWNLOAD_EXPIRES_SEC * 1000).toISOString()

  // Update export_jobs
  const { error: updateError } = await supabaseAdmin
    .from('export_jobs')
    .update({
      download_url: downloadUrl,
      download_expires_at: expiresAt,
    })
    .eq('id', exportJobId)

  if (updateError) {
    throw new Error(`Failed to update download URL: ${updateError.message}`)
  }

  return { downloadUrl, expiresAt }
}
