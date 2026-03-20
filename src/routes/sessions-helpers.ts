// ── 세션 타입 변환 헬퍼 (sessions.ts에서 분리) ───────────────────────────
// 테스트 가능하도록 별도 파일로 추출

import { encryptId } from '../lib/crypto.js'

export function sessionFromRow(row: Record<string, unknown>) {
  const rawId = row.id as string
  const rawUserId = (row.user_id as string) ?? null
  const rawPeerId = (row.peer_id as string) ?? null
  const rawAudioUrl = (row.audio_url as string) ?? null
  const rawCallRecordId = (row.call_record_id as string) ?? null
  const rawDupGroupId = (row.dup_group_id as string) ?? null
  const rawFileHash = (row.file_hash_sha256 as string) ?? null
  const rawAudioFP = (row.audio_fingerprint as string) ?? null
  const rawWavPath = (row.local_sanitized_wav_path as string) ?? null
  const rawTextPreview = (row.local_sanitized_text_preview as string) ?? null

  return {
    id: encryptId(rawId),
    title: row.title as string,
    date: row.date as string,
    duration: row.duration as number,
    qaScore: (row.qa_score as number) ?? 0,
    contributionScore: (row.contribution_score as number) ?? 0,
    labels: row.labels as any,
    strategyLocked: (row.strategy_locked as boolean) ?? false,
    assetType: (row.asset_type as any) ?? '업무/회의',
    audioMetrics: null,
    isPublic: (row.is_public as boolean) ?? false,
    visibilityStatus: (row.visibility_status as any) ?? 'PRIVATE',
    visibilitySource: (row.visibility_source as any) ?? 'MANUAL',
    visibilityConsentVersion: (row.visibility_consent_version as string) ?? null,
    visibilityChangedAt: (row.visibility_changed_at as string) ?? null,
    status: ((row.status as any) === 'pending' ? 'uploaded' : (row.status as any)) ?? 'uploaded',
    isPiiCleaned: (row.is_pii_cleaned as boolean) ?? false,
    hasDiarization: (row.has_diarization as boolean) ?? false,
    chunkCount: (row.chunk_count as number) ?? 0,
    audioUrl: rawAudioUrl ? encryptId(rawAudioUrl) : undefined,
    callRecordId: rawCallRecordId ? encryptId(rawCallRecordId) : undefined,
    dupStatus: (row.dup_status as any) ?? 'none',
    dupGroupId: rawDupGroupId ? encryptId(rawDupGroupId) : null,
    dupConfidence: (row.dup_confidence as number) ?? null,
    fileHashSha256: rawFileHash ? encryptId(rawFileHash) : null,
    audioFingerprint: rawAudioFP ? encryptId(rawAudioFP) : null,
    dupRepresentative: (row.dup_representative as boolean) ?? null,
    uploadStatus: (row.upload_status as any) ?? 'LOCAL',
    piiStatus: (row.pii_status as any) ?? 'CLEAR',
    shareScope: (row.share_scope as any) ?? 'PRIVATE',
    eligibleForShare: (row.eligible_for_share as boolean) ?? false,
    reviewAction: (row.review_action as any) ?? null,
    lockReason: (row.lock_reason as Record<string, unknown>) ?? null,
    lockStartMs: (row.lock_start_ms as number) ?? null,
    lockEndMs: (row.lock_end_ms as number) ?? null,
    localSanitizedWavPath: rawWavPath ? encryptId(rawWavPath) : null,
    localSanitizedTextPreview: rawTextPreview ? encryptId(rawTextPreview) : null,
    consentStatus: (row.consent_status as any) ?? 'locked',
    consentedAt: (row.consented_at as string) ?? null,
    verifiedSpeaker: (row.verified_speaker as boolean) ?? false,
    userId: rawUserId ? encryptId(rawUserId) : null,
    peerId: rawPeerId ? encryptId(rawPeerId) : null,
    labelStatus: (row.label_status as any) ?? null,
    labelSource: (row.label_source as any) ?? null,
    labelConfidence: typeof row.label_confidence === 'number' ? row.label_confidence : null,
  }
}

export function sessionToRow(s: any) {
  return {
    id: s.id,
    title: s.title,
    date: s.date,
    duration: s.duration,
    qa_score: s.qaScore ?? 0,
    contribution_score: s.contributionScore ?? 0,
    labels: s.labels,
    strategy_locked: s.strategyLocked ?? false,
    asset_type: s.assetType ?? '업무/회의',
    is_public: s.isPublic,
    visibility_status: s.visibilityStatus,
    visibility_source: s.visibilitySource,
    visibility_consent_version: s.visibilityConsentVersion,
    visibility_changed_at: s.visibilityChangedAt,
    status: s.status,
    is_pii_cleaned: s.isPiiCleaned,
    has_diarization: s.hasDiarization ?? false,
    chunk_count: s.chunkCount,
    audio_url: s.audioUrl,
    call_record_id: s.callRecordId,
    pii_status: s.piiStatus ?? 'CLEAR',
    share_scope: s.shareScope ?? 'PRIVATE',
    eligible_for_share: s.eligibleForShare ?? false,
    review_action: s.reviewAction ?? null,
    lock_reason: s.lockReason ?? null,
    lock_start_ms: s.lockStartMs ?? null,
    lock_end_ms: s.lockEndMs ?? null,
    local_sanitized_wav_path: s.localSanitizedWavPath ?? null,
    local_sanitized_text_preview: s.localSanitizedTextPreview ?? null,
    consent_status: s.consentStatus ?? 'locked',
    consented_at: s.consentedAt ?? null,
    verified_speaker: s.verifiedSpeaker ?? false,
    user_id: s.userId ?? null,
    peer_id: s.peerId ?? null,
    label_status: s.labelStatus ?? null,
    label_source: s.labelSource ?? null,
    label_confidence: s.labelConfidence ?? null,
  }
}
