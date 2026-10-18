import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { adminVisitorSummary, recordVisitor, visitorSummary } from '../worker/visitors.ts'
import type { Env, Statement, Value } from '../worker/platform.ts'
import { hash } from '../worker/platform.ts'
import { visitorDay, visitorRange, visitorQuery, automatedVisitor } from '../shared/visitor-analytics.ts'

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE partners(id TEXT PRIMARY KEY,slug TEXT,name TEXT,active INTEGER,created_at INTEGER)')
  db.exec(readFileSync(new URL('../migrations/0015_visitor_analytics.sql', import.meta.url), 'utf8'))
  db.exec(`CREATE TABLE orders(id TEXT PRIMARY KEY,mode TEXT,is_test INTEGER,payment_status TEXT,partner_id TEXT,updated_at INTEGER);
    CREATE TABLE order_events(order_id TEXT,action TEXT,created_at INTEGER);
    CREATE TABLE admin_sessions(token_hash TEXT,credential_version TEXT,expires_at INTEGER);
    ALTER TABLE partners ADD COLUMN auth_version INTEGER DEFAULT 0;
    CREATE TABLE partner_sessions(token_hash TEXT,partner_id TEXT,auth_version INTEGER,credential_version TEXT,expires_at INTEGER);`)
  db.exec(readFileSync(new URL('../migrations/0044_visitor_funnel.sql', import.meta.url), 'utf8'))
  db.prepare('INSERT INTO partners(id,slug,name,active,created_at) VALUES (?,?,?,?,?)').run('partner-a', 'ABCDEF', '代理 A', 1, 1)
  db.prepare('INSERT INTO partners(id,slug,name,active,created_at) VALUES (?,?,?,?,?)').run('partner-b', 'GHIJKL', '代理 B', 0, 2)
  const database = {
    prepare(sql: string): Statement {
      let values: Value[] = []
      return {
        bind(...next) { values = next; return this },
        async first<T>() { return (db.prepare(sql).get(...values) ?? null) as T | null },
        async all<T>() { return { results: db.prepare(sql).all(...values) as T[] } },
        async run() { return db.prepare(sql).run(...values) },
      }
    },
    async batch() { return [] },
  }
  return { db, env: { INTEREST_DB: database } as Env }
}

test('storefront visits are scoped by partner and deduplicated across pages and shops', async t => {
  const { db, env } = setup(); t.after(() => db.close())
  const visitorId = crypto.randomUUID()
  const send = (path: string, id = visitorId, origin = 'https://shop.example.invalid') => recordVisitor(new Request('https://shop.example.invalid/api/visitors', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ path, visitorId: id }),
  }), env)
  await send('/')
  await send('/product/chatgpt')
  await send('/r/ABCDEF')
  await send('/r/ABCDEF/product/chatgpt')
  await send('/r/ABCDEF/orders', crypto.randomUUID())
  const platform = await visitorSummary(env, new URL('https://shop.example.invalid/?days=7'), 'platform')
  const partner = await visitorSummary(env, new URL('https://shop.example.invalid/?days=7'), 'partner-a')
  const overall = await adminVisitorSummary(env, new URL('https://shop.example.invalid/?days=7'))
  assert.deepEqual([platform.visitors, platform.pageViews], [1, 2])
  assert.deepEqual([partner.visitors, partner.pageViews], [2, 3])
  assert.deepEqual([overall.visitors, overall.pageViews], [2, 5])
  assert.deepEqual([overall.partners[0].id, overall.partners[0].visitors], ['partner-a', 2])
  assert.deepEqual([overall.partners[1].id, overall.partners[1].visitors], ['partner-b', 0])
  assert.equal(overall.trend.length, 7)
  await assert.rejects(send('/r/GHIJKL'), { status: 404 })
  await assert.rejects(send('/admin'), { status: 400 })
  await assert.rejects(send('/', visitorId, 'https://evil.test'), { status: 403 })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visitor_days').get()!.n, 3)
})

test('Beijing calendar boundaries, leap days and strict custom ranges', () => {
  const now = Date.parse('2026-03-01T00:10:00+08:00')
  const range = (query: string) => visitorRange(new URLSearchParams(query), now)
  assert.deepEqual(range('period=yesterday'), { start: '2026-02-28', end: '2026-02-28', days: 1, since: Date.parse('2026-02-28T00:00:00+08:00'), until: Date.parse('2026-03-01T00:00:00+08:00') })
  assert.equal(range('period=today').start, '2026-03-01')
  assert.equal(range('days=90').days, 90)
  assert.equal(visitorRange(new URLSearchParams('start=2024-02-29&end=2024-03-01'), now).days, 2)
  for (const q of ['days=1', 'days=', 'period=custom', 'start=2026-02-29&end=2026-03-01', 'start=2026-03-01', 'start=2026-03-02&end=2026-03-01', 'start=2025-01-01&end=2026-03-01', 'start=2026-03-01&end=2026-03-02', 'days=7&period=today', 'start=2026-03-01&end=2026-03-01&days=7']) assert.throws(() => range(q), q)
  assert.equal(visitorQuery({ start: '2026-02-28', end: '2026-03-01' }), 'start=2026-02-28&end=2026-03-01')
  assert.equal(automatedVisitor('Mozilla/5.0 Chrome/140 Safari/537.36'), false)
  for (const ua of ['Googlebot/2.1', 'HeadlessChrome/140', 'curl/8', 'Go-http-client/1.1', 'Playwright']) assert.equal(automatedVisitor(ua), true)
})

test('funnel events do not inflate PV and deduplicate across days and shops', async t => {
  const { db, env } = setup(); t.after(() => db.close())
  const id = crypto.randomUUID()
  const send = (event = 'pageview', path = '/product/chatgpt', visitorId = id) => recordVisitor(new Request('https://shop.example.invalid/api/visitors', { method: 'POST', headers: { Origin: 'https://shop.example.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId, path, event }) }), env)
  // A checkout left open across midnight must not manufacture a page open/UV.
  await send('checkout')
  const eventOnly = await visitorSummary(env, new URL('https://shop.example.invalid/?period=today'))
  assert.deepEqual([eventOnly.visitors, eventOnly.pageViews, eventOnly.funnel.checkoutVisitors], [0, 0, 1])
  await send(); await send('checkout'); await send('checkout'); await send('payment'); await send('payment')
  await send('pageview', '/', crypto.randomUUID())
  const before = await visitorSummary(env, new URL('https://shop.example.invalid/?period=today'))
  assert.deepEqual([before.visitors, before.pageViews, before.effectiveVisitors, before.bounceRate], [2, 2, 1, 100])
  assert.deepEqual(before.funnel, { visitors: 2, productVisitors: 1, checkoutVisitors: 1, paymentVisitors: 1, paidOrders: 0 })
  assert.deepEqual({ ...before.today }, { visitors: 2, pageViews: 2 })
  const yesterday = visitorDay(Date.now() - 86400000)
  db.prepare('INSERT INTO visitor_days(day,shop_id,visitor_hash,page_views,product_view,checkout_view,payment_view) VALUES (?,?,?,?,1,1,1)').run(yesterday, 'partner-a', await hash(id), 1)
  const overall = await visitorSummary(env, new URL('https://shop.example.invalid/?days=7'))
  assert.deepEqual([overall.visitors, overall.pageViews, overall.effectiveVisitors, overall.bounceRate], [2, 3, 1, 50])
  assert.equal(overall.funnel.checkoutVisitors, 1)
  const past = await adminVisitorSummary(env, new URL(`https://shop.example.invalid/?start=${yesterday}&end=${yesterday}`))
  assert.deepEqual([past.visitors, past.pageViews, past.platform.visitors, past.partners[0].visitors], [1, 1, 0, 1])
  assert.equal(past.trend.length, 1)
  await assert.rejects(send('paid'), { status: 400 })
})

test('paid orders use first confirmation time, exclude test/demo, preserve refunds and isolate shops', async t => {
  const { db, env } = setup(); t.after(() => db.close())
  const range = visitorRange(new URLSearchParams('period=today'))
  for (const [id, mode, isTest, payment, partner, confirmed] of [
    ['live', 'live', 0, 'paid', null, range.since], ['partner', 'live', 0, 'paid', 'partner-a', range.until - 1],
    ['test', 'live', 1, 'paid', null, range.since], ['demo', 'demo', 0, 'simulated', null, range.since],
    ['old', 'live', 0, 'paid', null, range.since - 1], ['future', 'live', 0, 'paid', null, range.until],
    ['unpaid', 'live', 0, 'unpaid', null, range.since],
  ] as const) {
    db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)').run(id, mode, isTest, payment, partner, Date.now())
    db.prepare("INSERT INTO order_events VALUES (?,'payment-confirmed',?)").run(id, confirmed)
  }
  db.prepare("INSERT INTO order_events VALUES ('old','payment-confirmed',?)").run(range.since)
  db.prepare("INSERT INTO order_events VALUES ('live','payment-confirmed',?)").run(range.since)
  const url = new URL('https://shop.example.invalid/?period=today')
  assert.equal((await visitorSummary(env, url)).funnel.paidOrders, 2)
  assert.equal((await visitorSummary(env, url, 'platform')).funnel.paidOrders, 1)
  assert.equal((await visitorSummary(env, url, 'partner-a')).funnel.paidOrders, 1)
  const empty = await visitorSummary(env, new URL('https://shop.example.invalid/?period=yesterday'), 'partner-b')
  assert.deepEqual([empty.visitors, empty.effectiveRate, empty.bounceRate, empty.conversionRate], [0, 0, 0, 0])
})

test('recognized robots and valid staff sessions are excluded; stale cookies count normally', async t => {
  const { db, env } = setup(); t.after(() => db.close())
  const token = 'a'.repeat(64)
  env.ADMIN_USERNAME = 'fixture'; env.ADMIN_EMAIL = 'admin@example.test'; env.ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXP'.repeat(2)
  const version = await hash('admin-email-totp-v1:' + env.ADMIN_EMAIL + ':' + env.ADMIN_USERNAME + ':' + env.ADMIN_TOTP_SECRET)
  db.prepare('INSERT INTO admin_sessions VALUES (?,?,?)').run(await hash(token), version, Date.now() + 60000)
  env.PARTNER_AUTH_SECRET = 'fixture-partner-secret'.repeat(2)
  db.prepare('INSERT INTO partner_sessions VALUES (?,?,?,?,?)').run(await hash(token), 'partner-a', 0, await hash(env.PARTNER_AUTH_SECRET), Date.now() + 60000)
  const send = (extra: Record<string, string> = {}, automated = false) => recordVisitor(new Request('https://shop.example.invalid/api/visitors', { method: 'POST', headers: { Origin: 'https://shop.example.invalid', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ visitorId: crypto.randomUUID(), path: '/', automated }) }), env)
  await send({ 'User-Agent': 'Googlebot/2.1' }); await send({}, true)
  await send({ Cookie: `__Host-ymx_admin=${token}` }); await send({ Cookie: `__Host-ymx_partner=${token}` })
  assert.equal(db.prepare('SELECT count(*) n FROM visitor_days').get()!.n, 0)
  await send({ Cookie: `__Host-ymx_admin=${'b'.repeat(64)}` })
  db.prepare('UPDATE partner_sessions SET expires_at=0').run()
  await send({ Cookie: `__Host-ymx_partner=${token}` })
  assert.equal(db.prepare('SELECT count(*) n FROM visitor_days').get()!.n, 2)
})

test('90-day range includes older visits and keeps 30-day results separate', async t => {
  const { db, env } = setup(); t.after(() => db.close())
  const oldDay = new Date(Date.now() - 75 * 86400000 + 8 * 3600000).toISOString().slice(0, 10)
  db.prepare('INSERT INTO visitor_days(day,shop_id,visitor_hash,page_views) VALUES (?,?,?,?)').run(oldDay, 'partner-a', 'old-visitor', 3)
  const url = (days: number) => new URL(`https://shop.example.invalid/api/admin/visitors?days=${days}`)
  assert.deepEqual([ (await visitorSummary(env, url(30), 'partner-a')).pageViews, (await visitorSummary(env, url(90), 'partner-a')).pageViews ], [0, 3])
  const admin = await adminVisitorSummary(env, url(90))
  assert.equal(admin.trend.length, 90)
  assert.equal(admin.partners[0].pageViews, 3)
  await assert.rejects(visitorSummary(env, url(91)), { status: 400 })
})
