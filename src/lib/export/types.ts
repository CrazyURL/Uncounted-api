// ── Export-related TypeScript types ─────────────────────────────────────

/** Export job request payload (POST /admin/export-jobs) */
export type ExportJobPayload = {
  id?: string
  client_id: string
  delivery_profile_id: string
  status: 'draft' | 'queued' | 'processing' | 'packaging' | 'completed' | 'failed'
  filters: ExportFilters
  logs?: ExportLogEntry[]
  created_at?: string
  updated_at?: string
}

/** Filters used when creating/querying export jobs */
export type ExportFilters = {
  domains?: string[]
  qualityGrades?: ('A' | 'B' | 'C')[]
  qualityTiers?: string[]
  consentStatus?: string
  dateFrom?: string
  dateTo?: string
}

/** Single log entry appended to export_jobs.logs */
export type ExportLogEntry = {
  timestamp: string
  message: string
  level?: 'info' | 'warn' | 'error'
}

/** Billable unit row (camelCase, after transformation) */
export type BillableUnit = {
  id: string
  sessionId: string | null
  minuteIndex: number
  effectiveSeconds: number
  qualityGrade: 'A' | 'B' | 'C'
  qaScore: number
  qualityTier: string
  labelSource: string | null
  hasLabels: boolean
  consentStatus: string
  piiStatus: string
  lockStatus: string
  lockedByJobId: string | null
  sessionDate: string
  userId: string | null
  sourceSessionIds?: string[]
  deviceContext?: unknown
}

/** Lock request for billable units */
export type BillableUnitLockRequest = {
  unitIds: string[]
  jobId: string
}

/** Ledger entry update-status request */
export type LedgerStatusUpdateRequest = {
  ids: string[]
  status: string
  confirmedAmount?: number
}

/** Ledger confirm-job request */
export type LedgerConfirmJobRequest = {
  exportJobId: string
  totalPayment: number
}

/** Delivery record creation request */
export type DeliveryRecordCreateRequest = {
  buIds: string[]
  clientId: string
  exportJobId: string
}
