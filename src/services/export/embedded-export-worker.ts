// ── Embedded Export Worker (Phase 2B) ─────────────────────────────────
//
// SPEC_EXPORT_V2.md §6.3. export_embedded_jobs_v2 단건 embedded WAV job 의 백그라운드 처리.
//
// 흐름: queued → packaging → ready / failed.
//   1. status='packaging' 전이 (queued 가드)
//   2. 2차 eligibility 재검증 (비동기라 상태 변동 가능)
//   3. buildSessionExportZip(embedded) → ZIP S3 업로드 → storage_path 저장
//   4. 실패 시 status='failed' + error_message
//
// 안전선:
//   - download_url 은 DB 에 저장하지 않음 (GET 에서 동적 발급).
//   - 임시 ZIP 은 finally 에서 cleanup 보장 (디스크 누적 방지).
//   - legacy buildPackage / billable_units / ledger 미사용.

import { promises as fs } from 'node:fs'

import { supabaseAdmin } from '../../lib/supabase.js'
import { uploadObject, S3_AUDIO_BUCKET } from '../../lib/s3.js'
import { isExportEligible } from '../../lib/export/eligibility.js'
import { buildSessionExportZip } from './export-builder.js'

const EXPORT_BUCKET = process.env.S3_EXPORT_BUCKET ?? S3_AUDIO_BUCKET
const DOWNLOAD_TTL_SEC = 60 * 60 * 24 // 24h — GET 에서 발급할 signed URL 만료와 정렬

interface ExportJobV2Row {
  id: string
  status: string
  session_ids: string[]
  audio_export_mode: string
  include_restricted: boolean
}

async function setStage(jobId: string, stage: string): Promise<void> {
  await supabaseAdmin
    .from('export_embedded_jobs_v2')
    .update({ packaging_stage: stage, updated_at: new Date().toISOString() })
    .eq('id', jobId)
}

async function failJob(jobId: string, message: string): Promise<void> {
  await supabaseAdmin
    .from('export_embedded_jobs_v2')
    .update({ status: 'failed', error_message: message, updated_at: new Date().toISOString() })
    .eq('id', jobId)
}

/**
 * embedded export job 을 백그라운드로 실행한다.
 * 호출 측은 `void runEmbeddedExportJob(jobId)` 로 await 하지 않는다.
 */
export async function runEmbeddedExportJob(jobId: string): Promise<void> {
  // 1. job 조회
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('export_embedded_jobs_v2')
    .select('id, status, session_ids, audio_export_mode, include_restricted')
    .eq('id', jobId)
    .single()

  if (jobErr || !job) {
    console.error('[embedded-export-worker] job not found', { jobId, jobErr })
    return
  }
  const j = job as ExportJobV2Row
  const sessionId = j.session_ids?.[0]
  if (!sessionId) {
    await failJob(jobId, 'invalid_session_ids')
    return
  }

  // 2. queued → packaging (queued 가드: 중복 픽업 방지)
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('export_embedded_jobs_v2')
    .update({ status: 'packaging', packaging_stage: '시작', updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'queued')
    .select('id')

  if (claimErr) {
    console.error('[embedded-export-worker] claim failed', { jobId, claimErr })
    return
  }
  if (!claimed || claimed.length === 0) {
    // 이미 다른 워커가 픽업했거나 queued 가 아님 — 조용히 종료
    return
  }

  let zipPath: string | null = null
  try {
    // 3. 2차 eligibility 재검증 (embedded 는 항상 include_restricted=false)
    await setStage(jobId, '적격성 재검증')
    const { data: session, error: sessErr } = await supabaseAdmin
      .from('sessions')
      .select('consent_status, review_status, session_dataset_eligible')
      .eq('id', sessionId)
      .maybeSingle()

    if (sessErr) {
      await failJob(jobId, `session_lookup_failed: ${sessErr.message}`)
      return
    }
    const eligibility = isExportEligible(session)
    if (!eligibility.eligible) {
      await failJob(jobId, 'export_ineligible')
      return
    }

    // 4. ZIP 빌드 (embedded WAV 동봉)
    await setStage(jobId, '패키지 생성')
    const result = await buildSessionExportZip({
      sessionId,
      audioExportMode: 'embedded',
      includeRestricted: false, // 보정 #1: embedded 는 restricted 미허용
    })
    zipPath = result.zipPath

    // 5. S3 업로드 — iwinv 오브젝트 스토리지는 streaming(aws-chunked) 업로드를
    //    411 MissingContentLength 로 거부한다. 검증된 Buffer 기반 uploadObject 패턴 사용
    //    (uploadExportPackage 와 동일; createReadStream 스트리밍 금지).
    await setStage(jobId, 'S3 업로드')
    const key = `exports/v2/embedded/${sessionId}_${Date.now()}.zip`
    const zipBuffer = await fs.readFile(zipPath)
    await uploadObject(EXPORT_BUCKET, key, zipBuffer, 'application/zip')

    // 6. ready (download_url 은 저장하지 않음 — GET 에서 동적 발급)
    await supabaseAdmin
      .from('export_embedded_jobs_v2')
      .update({
        status: 'ready',
        packaging_stage: '완료',
        storage_path: key,
        size_bytes: zipBuffer.byteLength,
        download_expires_at: new Date(Date.now() + DOWNLOAD_TTL_SEC * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    const normalized = msg.includes('not export-eligible') ? 'export_ineligible' : msg
    console.error('[embedded-export-worker] build failed', { jobId, sessionId, err })
    await failJob(jobId, normalized)
  } finally {
    // 보정 #3: 성공/실패 무관 임시 ZIP cleanup (디스크 누적 방지)
    if (zipPath) {
      await fs.unlink(zipPath).catch(() => {})
    }
  }
}
