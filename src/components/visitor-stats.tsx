import { useId, useState, type ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Activity, ChartNoAxesCombined, Eye, LogOut, RefreshCw, Users } from 'lucide-react'
import { visitorDay, visitorPercent, visitorQuery, visitorRange, type VisitorPeriod } from '../../shared/visitor-analytics.ts'
export type { VisitorPeriod } from '../../shared/visitor-analytics.ts'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { useResource } from '@/lib/use-resource'
import { Feedback } from '@/components/workspace-loading'
import './visitor-stats.css'

export type VisitorSummary = {
  days: number
  visitors: number
  pageViews: number
  start: string
  end: string
  today: { visitors: number; pageViews: number }
  effectiveVisitors: number
  effectiveRate: number
  bounceRate: number
  conversionRate: number
  funnel: { visitors: number; productVisitors: number; checkoutVisitors: number; paymentVisitors: number; paidOrders: number }
  trend: { day: string; visitors: number; pageViews: number }[]
}

const chartConfig = {
  visitors: {
    label: '独立访客 (UV)',
    color: 'var(--primary)',
  },
  pageViews: {
    label: '页面浏览量 (PV)',
    color: 'var(--muted-foreground)',
  },
} satisfies ChartConfig

function TrendChart({ trend }: { trend: VisitorSummary['trend'] }) {
  const rawId = useId()
  const chartId = rawId.replace(/[^a-zA-Z0-9]/g, '')

  return (
    <>
      <ChartContainer
        config={chartConfig}
        className="visitor-chart"
        aria-label="每日访客数与浏览量趋势"
      >
        <AreaChart
          accessibilityLayer
          data={trend}
          margin={{ top: 14, right: 24, left: -12, bottom: 4 }}
        >
          <defs>
            <linearGradient id={`fill-visitors-${chartId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-visitors)" stopOpacity={0.4} />
              <stop offset="95%" stopColor="var(--color-visitors)" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id={`fill-pageViews-${chartId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-pageViews)" stopOpacity={0.25} />
              <stop offset="95%" stopColor="var(--color-pageViews)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />
          <XAxis
            dataKey="day"
            padding={{ left: 12, right: 12 }}
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            minTickGap={24}
            interval="preserveStartEnd"
            tickFormatter={(value) => String(value).slice(5)}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tickMargin={8}
            allowDecimals={false}
            domain={[0, 'auto']}
            tickCount={4}
          />
          <ChartTooltip
            cursor={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '3 3' }}
            content={
              <ChartTooltipContent
                indicator="dot"
                labelFormatter={(label) => `${label} (北京时间)`}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Area
            dataKey="pageViews"
            isAnimationActive={false}
            type="monotone"
            stroke="var(--color-pageViews)"
            strokeWidth={2}
            fill={`url(#fill-pageViews-${chartId})`}
            activeDot={{ r: 5, strokeWidth: 1.5, stroke: 'var(--card)' }}
          />
          <Area
            dataKey="visitors"
            isAnimationActive={false}
            type="monotone"
            stroke="var(--color-visitors)"
            strokeWidth={2.5}
            fill={`url(#fill-visitors-${chartId})`}
            activeDot={{ r: 6, strokeWidth: 2, stroke: 'var(--card)' }}
          />
        </AreaChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>每日访客趋势数据</caption>
        <thead>
          <tr>
            <th>日期</th>
            <th>独立访客</th>
            <th>浏览量</th>
          </tr>
        </thead>
        <tbody>
          {trend.map((row) => (
            <tr key={row.day}>
              <td>{row.day}</td>
              <td>{row.visitors}</td>
              <td>{row.pageViews}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

export function VisitorStats({
  endpoint,
  revision = 0,
  title = '访客统计',
  description,
  action,
  className,
  selectedDays,
  onDaysChange,
  onRefresh,
}: {
  endpoint: string
  revision?: number
  title?: string
  description?: string
  action?: ReactNode
  className?: string
  selectedDays?: VisitorPeriod
  onDaysChange?: (days: VisitorPeriod) => void
  onRefresh?: () => void
}) {
  const [internalDays, setInternalDays] = useState<VisitorPeriod>(7)
  const days = selectedDays ?? internalDays
  const setDays = onDaysChange ?? setInternalDays
  const [refresh, setRefresh] = useState(0)
  const [customOpen, setCustomOpen] = useState(typeof days === 'object')
  const [start, setStart] = useState(typeof days === 'object' ? days.start : visitorDay())
  const [end, setEnd] = useState(typeof days === 'object' ? days.end : visitorDay())
  const [rangeError, setRangeError] = useState('')
  const { data, error, loading } = useResource<VisitorSummary>(`${endpoint}?${visitorQuery(days)}`, revision + refresh)

  const avgDepth = data && data.visitors > 0 ? (data.pageViews / data.visitors).toFixed(1) : '0.0'
  const avgDailyVisitors = data ? (data.trend.reduce((sum, row) => sum + row.visitors, 0) / data.days).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '0'
  const peakDay = data?.trend.reduce((peak, row) => row.visitors > peak.visitors ? row : peak, { day: '', visitors: 0, pageViews: 0 })
  const funnel = data ? [
    ['进站访客', data.funnel.visitors], ['看过商品', data.funnel.productVisitors],
    ['进入结算', data.funnel.checkoutVisitors], ['进入支付页', data.funnel.paymentVisitors], ['付款订单', data.funnel.paidOrders],
  ] as const : []

  return (
    <Card className={`visitor-stats ${className ?? ''}`.trim()}>
      <CardHeader className="visitor-stats-heading">
        <div className="visitor-stats-title-group">
          <div className="visitor-stats-title-row">
            <ChartNoAxesCombined className="visitor-stats-icon" size={17} aria-hidden="true" />
            <CardTitle>{title}</CardTitle>
          </div>
          <CardDescription>
            {description || '前台每打开一个页面记一次浏览；同一浏览器在所选时间内只算一个访客。'}
          </CardDescription>
        </div>
        <div className="visitor-stats-actions">
          {action}
          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => onRefresh ? onRefresh() : setRefresh(v => v + 1)}><RefreshCw size={14} />刷新统计</Button>
          <div className="visitor-period" role="group" aria-label="统计时间范围">
            {(['today', 'yesterday', 7, 30, 90] as const).map(value => <Button key={value} type="button" variant={days === value ? 'secondary' : 'ghost'} size="sm" className="visitor-period-btn" aria-pressed={days === value} onClick={() => { setDays(value); setCustomOpen(false); setRangeError('') }}>{value === 'today' ? '今天' : value === 'yesterday' ? '昨天' : `近 ${value} 天`}</Button>)}
            <Button type="button" variant={typeof days === 'object' ? 'secondary' : 'ghost'} size="sm" className="visitor-period-btn" aria-pressed={typeof days === 'object'} aria-expanded={customOpen} onClick={() => { if (data) { setStart(data.start); setEnd(data.end) }; setCustomOpen(v => !v) }}>自定义</Button>
          </div>
        </div>
      </CardHeader>
      {customOpen && <form className="visitor-custom-range" onSubmit={event => {
        event.preventDefault()
        try { visitorRange(new URLSearchParams({ start, end })); setDays({ start, end }); setRangeError('') }
        catch (e) { setRangeError(e instanceof Error ? e.message : '日期范围无效。') }
      }}>
        <label>开始日期<input type="date" required max={visitorDay()} value={start} onChange={e => setStart(e.target.value)} /></label>
        <span aria-hidden="true">—</span>
        <label>结束日期<input type="date" required max={visitorDay()} value={end} onChange={e => setEnd(e.target.value)} /></label>
        <Button type="submit" variant="outline" size="sm">应用日期</Button>
        {rangeError && <p role="alert">{rangeError}</p>}
      </form>}
      <Feedback error={error} loading={loading} data={data} shape="compact" />
      {data && (
        <CardContent className="visitor-stats-content">
          <p className="visitor-scope-note">北京时间 {data.start} — {data.end} · 自动排除识别到的爬虫、自动化工具和当前已登录后台的浏览器。访问统计不保存 IP 和账号信息。</p>
          <div className="visitor-kpi-grid">
            <div className="visitor-kpi-card">
              <div className="visitor-kpi-label">
                <span className="visitor-kpi-dot visitor-kpi-dot-visitors" />
                <Users size={13} className="text-muted-foreground" />
                <span>独立访客 (UV)</span>
              </div>
              <div className="visitor-kpi-val-row">
                <strong className="visitor-kpi-value">{data.visitors.toLocaleString('zh-CN')}</strong>
                <span className="visitor-kpi-sub">今天：访客 {data.today.visitors.toLocaleString('zh-CN')} · 浏览 {data.today.pageViews.toLocaleString('zh-CN')}</span>
              </div>
            </div>
            <div className="visitor-kpi-card">
              <div className="visitor-kpi-label"><Activity size={13} /><span>有效访客</span></div>
              <strong className="visitor-kpi-value">{data.effectiveVisitors.toLocaleString('zh-CN')}</strong>
              <span className="visitor-kpi-sub">占访客 {data.effectiveRate}% · 浏览至少 2 次，或看过商品详情</span>
            </div>
            <div className="visitor-kpi-card">
              <div className="visitor-kpi-label">
                <span className="visitor-kpi-dot visitor-kpi-dot-pageviews" />
                <Eye size={13} className="text-muted-foreground" />
                <span>页面浏览量 (PV)</span>
              </div>
              <div className="visitor-kpi-val-row">
                <strong className="visitor-kpi-value">{data.pageViews.toLocaleString('zh-CN')}</strong>
                <span className="visitor-kpi-sub">人均 ~{avgDepth} 页</span>
              </div>
            </div>
            <div className="visitor-kpi-card">
              <div className="visitor-kpi-label">
                <LogOut size={13} className="text-muted-foreground" />
                <span>跳出率</span>
              </div>
              <div className="visitor-kpi-val-row">
                <strong className="visitor-kpi-value">
                  {data.bounceRate}%
                </strong>
                <span className="visitor-kpi-sub">
                  只浏览了 1 次页面的访客占比
                </span>
              </div>
            </div>
          </div>

          <section className="visitor-funnel" aria-label="购买漏斗">
            <div className="visitor-funnel-heading"><div><h3>购买漏斗</h3><p>各行为按所选时段独立统计并按访客去重；付款订单为同期真实支付确认的订单数。</p></div><strong>访客转化率 {data.conversionRate}%</strong></div>
            <ol>{funnel.map(([label, count], index) => {
              const previous = index ? funnel[index - 1][1] : 0
              return <li key={label}><span>{label}</span><div className="visitor-funnel-track" aria-hidden="true"><div style={{ width: `${Math.min(100, visitorPercent(count, data.visitors))}%` }} /></div><div className="visitor-funnel-value"><strong>{count.toLocaleString('zh-CN')}</strong>{index > 0 && <small>上一步的 {previous > 0 ? `${visitorPercent(count, previous)}%` : '—'}</small>}</div></li>
            })}</ol>
          </section>

          <div className="visitor-chart-wrapper">
            <div className="visitor-trend-heading"><h3>每日访问趋势</h3><span>日均 {avgDailyVisitors} 人 · 单日最高 {peakDay?.visitors ?? 0} 人{peakDay?.day ? `（${peakDay.day}）` : ''}</span></div>
            {data.pageViews ? (
              <TrendChart trend={data.trend} />
            ) : (
              <div className="visitor-empty">
                <div className="visitor-empty-icon">
                  <ChartNoAxesCombined size={22} aria-hidden="true" />
                </div>
                <strong>暂无访问数据</strong>
                <p>所选时间段内暂无访客访问商店。客户打开商店后，这里将自动呈现流量走势。</p>
              </div>
            )}
          </div>
          <p className="visitor-footnote">
            图表逐日去重，顶部访客在整个所选时段内去重。商品、结算和支付行为从功能启用后开始采集，历史浏览量保留。漏斗各步可能跨期，付款订单可能包含回访或同一访客的多笔订单，比例可能超过 100%；各步比例零分母显示「—」。
          </p>
        </CardContent>
      )}
    </Card>
  )
}
