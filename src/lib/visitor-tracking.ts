import { storefrontScopeHeaders } from './storefront-routing.ts'
import { automatedVisitor } from '../../shared/visitor-analytics.ts'
let lastPage = ''
let lastSent = 0
let ephemeralId = ''

export function trackVisitor(path: string, event: 'pageview' | 'checkout' | 'payment' = 'pageview') {
  if (navigator.webdriver || automatedVisitor(navigator.userAgent)) return
  const now = Date.now()
  const key = `${event}:${path}`
  if (key === lastPage && now - lastSent < 1500) return
  lastPage = key
  lastSent = now
  let visitorId: string
  try {
    const stored = localStorage.getItem('ymx-visitor-id')
    visitorId = stored && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(stored) ? stored : crypto.randomUUID()
    localStorage.setItem('ymx-visitor-id', visitorId)
  } catch { visitorId = ephemeralId ||= crypto.randomUUID() }
  void fetch('/api/visitors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...storefrontScopeHeaders({ pathname: path }) },
    body: JSON.stringify({ visitorId, path, event }),
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => { /* Analytics must never interrupt shopping. */ })
}
