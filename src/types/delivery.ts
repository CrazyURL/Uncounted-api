// ── Delivery & Export 공유 타입 ──────────────────────────────────────────
// 073_delivery_packages.sql 스키마와 1:1 대응

export interface DeliveryPackage {
  id: string
  package_number: string
  filename: string
  storage_path: string
  status: 'building' | 'complete' | 'pending' | 'archived'
  duration_seconds: number
  duration_minutes: number
  billable_hours: number
  session_count: number
  utterance_count: number
  size_bytes?: number | null
  created_at: string
  completed_at?: string | null
  delivered_at?: string | null
  delivered_to_client_id?: string | null
  metadata?: Record<string, unknown>
}

export interface ExportJobV2 {
  id: string
  type: 'single_session' | 'batch_session' | 'delivery_package'
  status: 'queued' | 'processing' | 'complete' | 'failed'
  session_ids?: string[] | null
  package_id?: string | null
  storage_path?: string | null
  user_id?: string | null
  progress: number
  total?: number | null
  error_message?: string | null
  created_at: string
  completed_at?: string | null
  expires_at?: string | null
}

export interface ExportLog {
  id: string
  type: 'layer1_package' | 'layer2_single' | 'layer3_batch'
  user_id?: string | null
  package_id?: string | null
  session_ids?: string[] | null
  storage_path?: string | null
  size_bytes?: number | null
  downloaded_at: string
  ip_address?: string | null
  user_agent?: string | null
}

export type AudioExportMode = 'reference_only' | 'signed_url' | 'embedded'
