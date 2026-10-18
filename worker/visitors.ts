import { ApiError, body, hash, json, readCookie, type Env } from './platform.ts'
import { requireAdmin } from './admin-auth.ts'
import { requirePartner } from './partner-auth.ts'
import { automatedVisitor, visitorDay, visitorPercent, visitorRange } from '../shared/visitor-analytics.ts'

function period(url: URL) {
  try { return visitorRange(url.searchParams) }
  catch (e) { throw new ApiError(e instanceof Error ? e.message : '日期范围无效。') }
}
async function staffVisitor(request: Request, env: Env) {
  for (const role of ['admin', 'partner']) {
    if (!readCookie(request, role)) continue
    try {
      if (role === 'admin') await requireAdmin(request, env)
      else await requirePartner(request, env)
      return true
    } catch (e) {
      // Stale/forged cookies cannot disable counting. Configuration may be absent.
      if (!(e instanceof ApiError) || (e.status !== 401 && !(role === 'admin' && e.status === 503))) throw e
    }
  }
  return false
}

export async function recordVisitor(request: Request, env: Env) {
  if (request.method !== 'POST') throw new ApiError('请使用 POST 提交。', 405)
  const data = await body(request, 512)
  if (data.automated !== undefined && typeof data.automated !== 'boolean') throw new ApiError('自动化标记无效。')
  const event = data.event ?? 'pageview'
  if (typeof event !== 'string' || !['pageview', 'checkout', 'payment'].includes(event)) throw new ApiError('统计事件无效。')
  if (data.automated === true || automatedVisitor(request.headers.get('User-Agent') ?? '') || await staffVisitor(request, env)) return json({ ok: true })
  if (typeof data.visitorId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(data.visitorId)) throw new ApiError('访客标识无效。')
  if (typeof data.path !== 'string' || !data.path || data.path.length > 120) throw new ApiError('页面路径无效。')
  const path = data.path.replace(/\/$/, '') || '/'
  const match = path.match(/^\/(?:r|s)\/([^/]+)(?:\/(?:orders|product\/[a-z0-9-]+))?$/)
  if (!match && path !== '/' && path !== '/orders' && !/^\/product\/[a-z0-9-]+$/.test(path)) throw new ApiError('页面路径无效。')
  let shopId = 'platform'
  if (match) {
    const partner = await env.INTEREST_DB.prepare('SELECT id FROM partners WHERE slug=? AND active=1').bind(match[1]).first<{ id: string }>()
    if (!partner) throw new ApiError('代理商店不可用。', 404)
    shopId = partner.id
  }
  const pageView = Number(event === 'pageview')
  const product = Number(event === 'pageview' && /\/product\/[a-z0-9-]+$/.test(path))
  await env.INTEREST_DB.prepare(`INSERT INTO visitor_days(day,shop_id,visitor_hash,page_views,product_view,checkout_view,payment_view) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(day,shop_id,visitor_hash) DO UPDATE SET page_views=page_views+excluded.page_views,
    product_view=MAX(product_view,excluded.product_view),checkout_view=MAX(checkout_view,excluded.checkout_view),payment_view=MAX(payment_view,excluded.payment_view)`)
    .bind(visitorDay(), shopId, await hash(data.visitorId), pageView, product, Number(event === 'checkout'), Number(event === 'payment')).run()
  return json({ ok: true })
}

export async function visitorSummary(env: Env, url: URL, shopId?: string) {
  const range = period(url)
  const { days, start, end, since, until } = range
  const filter = shopId ? 'day BETWEEN ? AND ? AND shop_id=?' : 'day BETWEEN ? AND ?'
  const args = shopId ? [start, end, shopId] : [start, end]
  const rows = (await env.INTEREST_DB.prepare(`SELECT day,SUM(page_views) pageViews,COUNT(DISTINCT CASE WHEN page_views>0 THEN visitor_hash END) visitors FROM visitor_days WHERE ${filter} GROUP BY day ORDER BY day`).bind(...args).all<{ day: string; pageViews: number; visitors: number }>()).results
  const total = await env.INTEREST_DB.prepare(`WITH people AS (
    SELECT visitor_hash,SUM(page_views) views,MAX(product_view) product,MAX(checkout_view) checkout,MAX(payment_view) payment
    FROM visitor_days WHERE ${filter} GROUP BY visitor_hash)
    SELECT COALESCE(SUM(views),0) pageViews,COUNT(CASE WHEN views>0 THEN 1 END) visitors,
    COALESCE(SUM(CASE WHEN views>=2 OR product=1 THEN 1 ELSE 0 END),0) effectiveVisitors,
    COALESCE(SUM(CASE WHEN views=1 THEN 1 ELSE 0 END),0) bouncedVisitors,
    COALESCE(SUM(product),0) productVisitors,COALESCE(SUM(checkout),0) checkoutVisitors,COALESCE(SUM(payment),0) paymentVisitors FROM people`)
    .bind(...args).first<{ pageViews: number; visitors: number; effectiveVisitors: number; bouncedVisitors: number; productVisitors: number; checkoutVisitors: number; paymentVisitors: number }>()
  const today = await env.INTEREST_DB.prepare(`SELECT COALESCE(SUM(page_views),0) pageViews,COUNT(DISTINCT CASE WHEN page_views>0 THEN visitor_hash END) visitors FROM visitor_days WHERE day=?${shopId ? ' AND shop_id=?' : ''}`)
    .bind(...(shopId ? [visitorDay(), shopId] : [visitorDay()])).first<{ pageViews: number; visitors: number }>()
  // Audit confirmation time is immutable, unlike order/payment updated_at.
  // DISTINCT also protects imports with more than one confirmation audit event.
  const paid = await env.INTEREST_DB.prepare(`SELECT COUNT(DISTINCT o.id) paidOrders FROM order_events e JOIN orders o ON o.id=e.order_id
    WHERE e.action='payment-confirmed' AND e.created_at>=? AND e.created_at<? AND o.mode='live' AND o.is_test=0 AND o.payment_status='paid'
    AND NOT EXISTS(SELECT 1 FROM order_events earlier WHERE earlier.order_id=e.order_id AND earlier.action='payment-confirmed' AND earlier.created_at<e.created_at)
    ${shopId ? (shopId === 'platform' ? 'AND o.partner_id IS NULL' : 'AND o.partner_id=?') : ''}`)
    .bind(...(shopId && shopId !== 'platform' ? [since, until, shopId] : [since, until])).first<{ paidOrders: number }>()
  const byDay = new Map(rows.map(row => [row.day, row]))
  const trend = Array.from({ length: days }, (_, index) => {
    const day = visitorDay(since + index * 86400000)
    return byDay.get(day) ?? { day, pageViews: 0, visitors: 0 }
  })
  const visitors = total?.visitors ?? 0, paidOrders = paid?.paidOrders ?? 0
  return { days, start, end, pageViews: total?.pageViews ?? 0, visitors, trend, today: today ?? { pageViews: 0, visitors: 0 },
    effectiveVisitors: total?.effectiveVisitors ?? 0, effectiveRate: visitorPercent(total?.effectiveVisitors ?? 0, visitors),
    bounceRate: visitorPercent(total?.bouncedVisitors ?? 0, visitors), conversionRate: visitorPercent(paidOrders, visitors),
    funnel: { visitors, productVisitors: total?.productVisitors ?? 0, checkoutVisitors: total?.checkoutVisitors ?? 0, paymentVisitors: total?.paymentVisitors ?? 0, paidOrders } }
}

export async function adminVisitorSummary(env: Env, url: URL) {
  const summary = await visitorSummary(env, url)
  const { start, end } = summary
  const platform = await env.INTEREST_DB.prepare("SELECT COALESCE(SUM(page_views),0) pageViews,COUNT(DISTINCT CASE WHEN page_views>0 THEN visitor_hash END) visitors FROM visitor_days WHERE day BETWEEN ? AND ? AND shop_id='platform'").bind(start, end).first<{ pageViews: number; visitors: number }>()
  const partners = (await env.INTEREST_DB.prepare(`SELECT p.id,p.name,p.slug,p.active,COALESCE(SUM(v.page_views),0) pageViews,COUNT(DISTINCT CASE WHEN v.page_views>0 THEN v.visitor_hash END) visitors
    FROM partners p LEFT JOIN visitor_days v ON v.shop_id=p.id AND v.day BETWEEN ? AND ? GROUP BY p.id ORDER BY visitors DESC,pageViews DESC,p.created_at DESC`).bind(start, end).all<{ id: string; name: string; slug: string; active: number; pageViews: number; visitors: number }>()).results
  return { ...summary, platform: platform ?? { pageViews: 0, visitors: 0 }, partners }
}
