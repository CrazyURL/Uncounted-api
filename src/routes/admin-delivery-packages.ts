// ── Admin Delivery Packages Routes (창 D — Layer 1) ───────────────────
//
// SPEC_EXPORT_V2.md §6.4 ~ §6.6.
//
// 본 창 산출 = 라우트 surface + 501 + 차단 사유.
// 실제 동작은 Window A 075+ (delivery_packages 테이블) +
// Window C (buildDeliveryPackageZip placeholder 교체) 완료 후 별도 워크스트림.

import { Hono } from 'hono'

import { supabaseAdmin } from '../lib/supabase.js'
import { authMiddleware, adminMiddleware } from '../lib/middleware.js'

const adminDeliveryPackages = new Hono()

adminDeliveryPackages.use('/*', authMiddleware)
adminDeliveryPackages.use('/*', adminMiddleware)

const TABLE_MISSING_MSG =
  'delivery_packages table missing: requires Window A follow-up migration (075+). ' +
  'Current migrations 070~074 do not create delivery_packages. ' +
  'See SPEC_EXPORT_V2.md §4.6 (16 row mapping).'

// ── 6.4 패키지 목록 ──────────────────────────────────────────────────
adminDeliveryPackages.get('/delivery/packages', async (c) => {
  // 테이블 부재 사전 확인 — Supabase 원시 에러 메시지 유출 방지
  const { error } = await supabaseAdmin
    .from('delivery_packages')
    .select('id', { count: 'exact', head: true })

  if (error && /relation .* does not exist/i.test(error.message)) {
    return c.json({ success: false, error: TABLE_MISSING_MSG }, 501)
  }
  if (error) {
    return c.json({ success: false, error: error.message }, 500)
  }

  const page = Math.max(1, Number(c.req.query('page') ?? '1'))
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? '20')))
  const from = (page - 1) * limit
  const to = from + limit - 1

  const { data, error: listError, count } = await supabaseAdmin
    .from('delivery_packages')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to)

  if (listError) {
    return c.json({ success: false, error: listError.message }, 500)
  }

  return c.json({
    success: true,
    data: data ?? [],
    meta: { total: count ?? 0, page, limit },
  })
})

// ── 6.5 패키지 다운로드 ──────────────────────────────────────────────
adminDeliveryPackages.get('/delivery/packages/:id/download', (c) => {
  return c.json(
    {
      success: false,
      error:
        TABLE_MISSING_MSG +
        ' Also requires buildDeliveryPackageZip() (Window C placeholder).',
    },
    501,
  )
})

// ── 6.6 Packaging worker 트리거 ──────────────────────────────────────
adminDeliveryPackages.post('/packaging/run', async (c) => {
  // packaging-worker.ts 의 함수를 호출하지만, 의존성 미충족으로 항상 triggered=false 반환.
  // 호출 자체는 시도하여 후속 워크스트림에서 함수 본문 채우면 자동으로 동작 전환되도록.
  const { runPackagingWorker } = await import('../services/packaging-worker.js')
  const result = await runPackagingWorker()

  return c.json(
    {
      success: false,
      error:
        TABLE_MISSING_MSG +
        ' packaging-worker entry exists in services/ but cannot persist without delivery_packages. ' +
        `reason: ${result.reason ?? 'unknown'}`,
    },
    501,
  )
})

export default adminDeliveryPackages
