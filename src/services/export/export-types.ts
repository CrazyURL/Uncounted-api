/**
 * Export v2 — 공용 타입 정의.
 *
 * Layer 2 (단일 세션) ZIP 빌드용 옵션 / 결과 / manifest.
 * Layer 1 (delivery package) / Layer 3 (batch) 은 본 단계에서 placeholder 만 둠.
 */

export type AudioExportMode = 'reference_only' | 'embedded'

export interface BuildSessionExportOptions {
  sessionId: string
  /** WAV 동봉 여부. default false. */
  includeAudio?: boolean
  /**
   * 오디오 export 모드. default 'reference_only'.
   * includeAudio=false 면 무조건 'reference_only' 로 강제.
   */
  audioExportMode?: AudioExportMode
  /** restricted/locked/review-미승인 세션을 강제 포함할지. default false. */
  includeRestricted?: boolean
  /** staging dir base. default OS tmp. */
  outputDir?: string
  /**
   * Sync Integrity Gate(D1) 활성화 여부. default false.
   * false → 기존 export 동작 그대로(미배선). true → 발화별 참조무결성 검증 후
   * 실패 발화 fail-closed 제외 + metadata/sync_quality_report.json 동봉.
   * (production 기본 활성화는 별도 게이트 — PR-per-step.)
   */
  enableSyncIntegrityGate?: boolean
}

export interface ExportSafetySummary {
  violations: string[]
  warnings: string[]
}

export interface BuildSessionExportResult {
  zipPath: string
  manifest: ExportManifest
  safety: ExportSafetySummary
}

export interface ExportManifest {
  manifest_version: 'v2'
  session_id: string
  audio_export_mode: AudioExportMode
  include_audio: boolean
  include_restricted: boolean
  generated_at: string
  counts: {
    utterances: number
    labels: number
    pii_labels: number
  }
}
