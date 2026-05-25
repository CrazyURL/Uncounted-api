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

// 데이터/RPC/admin 전용 클라이언트. service_role 권한으로만 동작해야 한다.
// 주의: 이 클라이언트에 signInWithPassword / refreshSession / setSession 을 호출하지 말 것.
// 그러면 supabase-js 가 Authorization 헤더를 사용자(authenticated) JWT 로 바꿔
// 이후의 .from / .rpc 가 service_role 이 아닌 authenticated 로 실행된다.
// auth flow(로그인/갱신)는 아래 supabaseAuth 를 사용한다.
export const supabaseAdmin: SupabaseClient = createClient(url, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

// auth flow 전용 클라이언트(로그인/토큰갱신). 사용자 세션을 설정하는 호출
// (signInWithPassword / refreshSession / setSession)은 반드시 이 클라이언트로 한다.
// supabaseAdmin 과 분리해 데이터 클라이언트의 service_role 신원이 오염되지 않게 한다.
// 데이터 조회/쓰기(.from / .rpc)에는 사용하지 않는다.
export const supabaseAuth: SupabaseClient = createClient(url, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

/**
 * Supabase PostgREST는 단일 쿼리당 MAX_ROWS=1000으로 잘린다.
 * 이 헬퍼는 `.range(from, to)` 기반으로 전체 행을 페이지네이션 수집한다.
 *
 * 주의: queryFactory는 매 호출마다 **새로운** 쿼리 빌더를 반환해야 한다.
 * Supabase 쿼리 빌더는 chain 호출 시 내부 상태를 변경하므로 재사용 불가.
 *
 * @example
 *   const rows = await fetchAllPaginated<Row>(() =>
 *     supabaseAdmin.from('utterances').select('*').eq('upload_status', 'uploaded').order('id')
 *   )
 */
// Supabase 쿼리 빌더는 `.range()` 이후 await 가능한 thenable이지만
// PostgrestFilterBuilder 타입을 정확히 기술하기 복잡하므로 any로 통과시킨다.
// 런타임에서는 `{ data, error }` 구조를 받게 된다.
type QueryBuilderLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  range: (from: number, to: number) => any
}

export async function fetchAllPaginated<T = Record<string, unknown>>(
  queryFactory: () => QueryBuilderLike,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = []
  let from = 0
  // 무한루프 방어: 발화 최대 100만 건 한도
  const HARD_CAP = 1_000_000
  while (from < HARD_CAP) {
    const to = from + pageSize - 1
    const result = (await queryFactory().range(from, to)) as {
      data: unknown
      error: { message?: string } | null
    }
    if (result.error) {
      const msg = result.error.message ?? String(result.error)
      throw new Error(`fetchAllPaginated failed at range [${from},${to}]: ${msg}`)
    }
    const rows = (result.data ?? []) as T[]
    all.push(...rows)
    if (rows.length < pageSize) break
    from += pageSize
  }
  return all
}
