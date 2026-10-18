// All calendar boundaries are Beijing time; end timestamps are exclusive.
export const visitorDay = (time = Date.now()) => new Date(time + 28_800_000).toISOString().slice(0, 10)
export type VisitorPeriod = 7 | 30 | 90 | 'today' | 'yesterday' | { start: string; end: string }
export function visitorQuery(period: VisitorPeriod) {
  return typeof period === 'object' ? `start=${period.start}&end=${period.end}`
    : typeof period === 'number' ? `days=${period}` : `period=${period}`
}
export function visitorRange(params: URLSearchParams, now = Date.now()) {
  const today = visitorDay(now)
  const parse = (day: string) => {
    const time = Date.parse(`${day}T00:00:00+08:00`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(time) || visitorDay(time) !== day) throw new Error('日期无效。')
    return time
  }
  let start: string, end: string
  if (params.has('start') || params.has('end')) {
    if (params.has('days') || params.has('period')) throw new Error('请只选择一种时间范围。')
    start = params.get('start') ?? ''; end = params.get('end') ?? ''
  } else if (params.has('period')) {
    if (params.has('days')) throw new Error('请只选择一种时间范围。')
    const period = params.get('period')
    if (period !== 'today' && period !== 'yesterday') throw new Error('时间范围无效。')
    start = end = visitorDay(now - (period === 'yesterday' ? 86_400_000 : 0))
  } else {
    const days = params.get('days') ?? '7'
    if (!['7', '30', '90'].includes(days)) throw new Error('仅支持最近 7、30 或 90 天。')
    start = visitorDay(now - (Number(days) - 1) * 86_400_000); end = today
  }
  const since = parse(start), until = parse(end) + 86_400_000
  const days = (until - since) / 86_400_000
  if (days < 1 || days > 366 || end > today) throw new Error('日期范围须为不超过今天的连续 1 至 366 天。')
  return { start, end, since, until, days }
}
export const automatedVisitor = (userAgent: string) => /bot\b|spider|crawler|headless|playwright|puppeteer|selenium|phantomjs|lighthouse|curl\/|wget\/|python-requests|go-http-client/i.test(userAgent)
export const visitorPercent = (part: number, total: number) => total > 0 ? Math.round(part / total * 1000) / 10 : 0
