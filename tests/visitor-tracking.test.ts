import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { trackVisitor } from '../src/lib/visitor-tracking.ts'

function browser(t: TestContext) {
  const saved = ['navigator', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  let stored = ''
  const navigator = { webdriver: false, userAgent: 'Mozilla/5.0 Chrome/140 Safari/537.36' }
  const storage = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value } }
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  const calls: RequestInit[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => { calls.push(options); return Response.json({ ok: true }) })
  return { navigator, storage, calls }
}

test('pageview deduplication keeps checkout/payment events and shop scope with one anonymous ID', t => {
  const { calls } = browser(t)
  const path = '/r/ABCDEF/product/chatgpt'
  trackVisitor(path); trackVisitor(path)
  trackVisitor(path, 'checkout'); trackVisitor(path, 'payment')
  assert.equal(calls.length, 3)
  const bodies = calls.map(c => JSON.parse(c.body as string))
  assert.deepEqual(bodies.map(b => b.event), ['pageview', 'checkout', 'payment'])
  assert.equal(new Set(bodies.map(b => b.visitorId)).size, 1)
  assert.match(bodies[0].visitorId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/)
  assert.ok(calls.every(c => (c.headers as Record<string, string>)['X-Storefront-Shop'] === 'ABCDEF' && c.credentials === 'same-origin' && c.keepalive))
  assert.deepEqual(Object.keys(bodies[0]).sort(), ['event', 'path', 'visitorId'])
})

test('webdriver and recognized automated user agents do not send telemetry', t => {
  const { calls, navigator } = browser(t)
  navigator.webdriver = true; trackVisitor('/product/gemini')
  navigator.webdriver = false; navigator.userAgent = 'HeadlessChrome/140'; trackVisitor('/product/duolingo')
  assert.equal(calls.length, 0)
})

test('storage denial and failed telemetry never interrupt shopping or change the in-memory ID', async t => {
  const { calls, storage } = browser(t)
  storage.getItem = () => { throw new Error('storage denied') }
  assert.doesNotThrow(() => { trackVisitor('/product/gmail'); trackVisitor('/product/gmail', 'checkout') })
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[0].body as string).visitorId, JSON.parse(calls[1].body as string).visitorId)
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  assert.doesNotThrow(() => trackVisitor('/orders'))
  await new Promise(resolve => setImmediate(resolve))
})

test('invalid cached visitor ID is replaced with a canonical ID', t => {
  const { calls, storage } = browser(t)
  storage.getItem = () => '-'.repeat(36)
  trackVisitor('/product/codex-sms')
  assert.match(JSON.parse(calls[0].body as string).visitorId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/)
})
