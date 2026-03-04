// ── Supabase Admin Client (Backend) ────────────────────────────────────
// service_role 키로 RLS 우회 — 서버사이드 전용
// SUPABASE_SERVICE_ROLE_KEY 환경변수 필수

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  throw new Error(
    'Missing environment variables:\n' +
    '- SUPABASE_URL\n' +
    '- SUPABASE_SERVICE_ROLE_KEY\n' +
    'Please configure .env file'
  )
}

export const supabaseAdmin: SupabaseClient = createClient(url, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})
