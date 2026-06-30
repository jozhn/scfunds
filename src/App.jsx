import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  Download,
  ExternalLink,
  Filter,
  Gauge,
  Info,
  LineChart,
  PieChart,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  PERIODS,
  computeMaxDrawdown,
  daysBetween,
  formatDays,
  formatNumber,
  formatPercent,
  shiftDate,
  sliceHistory,
} from './lib/finance'
import './App.css'

const PERIOD_LABELS = Object.fromEntries(PERIODS.map((period) => [period.key, period.label]))
const DEFAULT_PERIOD = '1y'
const DATA_URL = `${import.meta.env.BASE_URL}data/funds.json`
const PERFORMANCE_CARD_PERIODS = [
  { key: '1m', label: '近1月' },
  { key: '3m', label: '近3月' },
  { key: '6m', label: '近6月' },
  { key: '1y', label: '近1年' },
  { key: '3y', label: '近3年' },
  { key: '5y', label: '近5年' },
]
const DEFAULT_PORTFOLIO_TOTAL = 500000
const DEFAULT_PORTFOLIO_ROWS = [
  { token: 'QDUR134CNY', amount: 105000 },
  { token: '016664', amount: 80000 },
  { token: '270023', amount: 70000 },
  { token: '968061', amount: 55000 },
  { token: '016452', amount: 40000 },
  { token: '007280', amount: 25000 },
  { token: '002610', amount: 50000 },
  { token: '001219', amount: 50000 },
  { token: '016633', amount: 25000 },
]

function unpackHistory(history = []) {
  return history.map(([date, value, dailyReturn]) => ({ date, value, dailyReturn }))
}

function unpackGrowthSeries(series = []) {
  return series.map(([date, value, benchmarkValue, performanceValue]) => ({
    date,
    value,
    benchmarkValue,
    performanceValue,
  }))
}

function metricFor(fund, viewMode, periodKey) {
  const metrics = viewMode === 'cny' ? fund.cnyMetrics : fund.localMetrics
  return metrics?.intervals?.[periodKey] || null
}

function historyFor(fund, viewMode) {
  if (viewMode === 'cny' && fund.historyCny?.length) return unpackHistory(fund.historyCny)
  return unpackHistory(fund.historyLocal)
}

function returnHistoryFor(fund, viewMode) {
  if (viewMode === 'cny' && fund.returnHistoryCny?.length) return unpackHistory(fund.returnHistoryCny)
  if (fund.returnHistoryLocal?.length) return unpackHistory(fund.returnHistoryLocal)
  return historyFor(fund, viewMode)
}

function portfolioHistoryFor(fund) {
  if (fund.returnHistoryCny?.length) return unpackHistory(fund.returnHistoryCny)
  if (fund.returnHistoryLocal?.length) return unpackHistory(fund.returnHistoryLocal)
  if (fund.historyCny?.length) return unpackHistory(fund.historyCny)
  return unpackHistory(fund.historyLocal)
}

function dailyRows(history = []) {
  const points = [...history].sort((a, b) => a.date.localeCompare(b.date))
  return points.map((point, index) => {
    const previous = points[index - 1]
    const dailyReturn = Number.isFinite(point.dailyReturn)
      ? point.dailyReturn
      : previous?.value
        ? point.value / previous.value - 1
        : null
    return { ...point, dailyReturn }
  })
}

function latestDailyReturn(history = []) {
  return dailyRows(history).at(-1)?.dailyReturn ?? null
}

function periodReturn(history = [], periodKey) {
  const points = [...history].sort((a, b) => a.date.localeCompare(b.date))
  if (points.length < 2) return null

  const end = points.at(-1)
  const period = PERIODS.find((item) => item.key === periodKey)
  if (!period) return null
  const startDate = sliceHistory(points, periodKey)[0]?.date || ''

  const start = points.find((point) => point.date >= startDate)
  if (!start || start.date === end.date) return null
  if (period.minDays && daysBetween(start.date, end.date) < period.minDays) return null
  return end.value / start.value - 1
}

function normalizedReturnSeries(history = [], periodKey) {
  const points = sliceHistory(history, periodKey)
  if (points.length < 2) return []

  const period = PERIODS.find((item) => item.key === periodKey)
  const days = daysBetween(points[0].date, points.at(-1).date)
  if (period?.minDays && days < period.minDays) return []

  const base = points[0].value
  return points.map((point) => ({
    date: point.date,
    value: point.value / base - 1,
  }))
}

function resetGrowthSeries(points = [], periodKey) {
  const allPoints = [...points].sort((a, b) => a.date.localeCompare(b.date))
  if (allPoints.length < 2) return []

  const endDate = allPoints.at(-1).date
  const period = PERIODS.find((item) => item.key === periodKey)
  const startDate = period ? shiftDate(endDate, period.amount, period.unit) : allPoints[0].date
  const visible = allPoints.filter((point) => point.date >= startDate)
  const first = visible[0]
  if (!first) return []

  const resetValue = (value, base) =>
    Number.isFinite(value) && Number.isFinite(base) ? (1 + value) / (1 + base) - 1 : null

  return visible.map((point) => ({
    date: point.date,
    value: resetValue(point.value, first.value),
    benchmarkValue: resetValue(point.benchmarkValue, first.benchmarkValue),
    performanceValue: resetValue(point.performanceValue, first.performanceValue),
  }))
}

function isForeignCurrency(fund) {
  return fund.currencyCode && fund.currencyCode !== 'CNY'
}

function holdingSearchText(fund) {
  const profile = fund.holdingProfile || {}
  const allocations = [...(profile.geography || []), ...(profile.sector || []), ...(profile.asset || [])]
  const holdings = profile.topHoldings || []
  const fundHoldings = profile.fundHoldings || []
  const targetHoldings = fundHoldings.flatMap((holding) => holding.targetHoldings || [])

  return [
    ...allocations.flatMap((item) => [item.label]),
    ...holdings.flatMap((holding) => [holding.name, holding.country, holding.sector]),
    ...fundHoldings.flatMap((holding) => [holding.name, holding.code]),
    ...targetHoldings.flatMap((holding) => [holding.name, holding.code, holding.country, holding.sector]),
  ]
    .filter(Boolean)
    .join(' ')
}

function isFiniteWeight(value) {
  return Number.isFinite(Number(value))
}

function mergedHoldings(holdings) {
  const byKey = new Map()

  for (const holding of holdings) {
    if (!holding?.name || !isFiniteWeight(holding.weight)) continue

    const key = holding.code || holding.secid || holding.name
    const current = byKey.get(key)
    if (!current) {
      byKey.set(key, { ...holding, weight: Number(holding.weight) })
      continue
    }

    byKey.set(key, {
      ...current,
      country: current.country || holding.country || '',
      sector: current.sector || holding.sector || '',
      weight: Number((current.weight + Number(holding.weight)).toFixed(6)),
    })
  }

  return [...byKey.values()].sort((a, b) => b.weight - a.weight)
}

function displayHoldings(fund) {
  const profile = fund.holdingProfile || {}
  const directHoldings = profile.topHoldings || []
  if (profile.topHoldingsLookThrough) return directHoldings

  const throughHoldings = (profile.fundHoldings || []).flatMap((fundHolding) => {
    if (!isFiniteWeight(fundHolding.weight)) return []

    return (fundHolding.targetHoldings || [])
      .filter((holding) => isFiniteWeight(holding.weight))
      .map((holding) => ({
        ...holding,
        weight: Number(((Number(fundHolding.weight) * Number(holding.weight)) / 100).toFixed(6)),
        lookThrough: true,
      }))
  })

  if (!throughHoldings.length) return directHoldings
  return mergedHoldings([...throughHoldings, ...directHoldings])
}

function hasLookThroughHoldings(fund) {
  if (fund.holdingProfile?.topHoldingsLookThrough) return true

  return (fund.holdingProfile?.fundHoldings || []).some(
    (holding) => isFiniteWeight(holding.weight) && holding.targetHoldings?.length,
  )
}

function mainHoldings(fund, limit = 3) {
  return displayHoldings(fund).slice(0, limit)
}

function effectiveFeeRate(fund) {
  const rate = fund.purchaseFee?.effectiveRate
  return Number.isFinite(rate) ? rate : null
}

function formatFeeRate(rate) {
  return Number.isFinite(rate) ? formatPercent(rate, rate > 0 && rate < 0.01 ? 2 : 1) : '-'
}

function classForValue(value, inverted = false) {
  if (!Number.isFinite(value) || value === 0) return ''
  const positive = inverted ? value < 0 : value > 0
  return positive ? 'positive' : 'negative'
}

function compareValues(a, b, direction) {
  if (a === b) return 0
  if (a === null || a === undefined || Number.isNaN(a)) return 1
  if (b === null || b === undefined || Number.isNaN(b)) return -1
  if (typeof a === 'string') return direction * a.localeCompare(b, 'zh-Hans-CN')
  return direction * (a - b)
}

function getSortValue(fund, sortKey, viewMode, periodKey) {
  const metric = metricFor(fund, viewMode, periodKey)

  switch (sortKey) {
    case 'return':
      return metric?.totalReturn
    case 'daily':
      return latestDailyReturn(historyFor(fund, viewMode))
    case 'annualized':
      return metric?.annualizedReturn
    case 'sharpe':
      return metric?.sharpe
    case 'drawdown':
      return metric?.maxDrawdown
    case 'recovery':
      return metric?.drawdown?.recoveryDays ?? metric?.drawdown?.unrecoveredDays
    case 'fee':
      return metric?.feeBreakEvenDays
    case 'feeRate':
      return effectiveFeeRate(fund)
    case 'risk':
      return fund.riskRating
    case 'name':
      return fund.name
    default:
      return metric?.annualizedReturn
  }
}

function uniqueOptions(funds, key) {
  return [...new Set(funds.map((fund) => fund[key]).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN'),
  )
}

function SelectControl({ icon: Icon, label, value, onChange, options }) {
  return (
    <label className="control">
      <span className="control-label">
        {Icon && <Icon size={14} />}
        {label}
      </span>
      <span className="select-shell">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown size={15} />
      </span>
    </label>
  )
}

function NumberControl({ label, value, onChange, min, max, step = 1, suffix }) {
  return (
    <label className="control">
      <span className="control-label">{label}</span>
      <span className="number-shell">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {suffix && <span>{suffix}</span>}
      </span>
    </label>
  )
}

function Stat({ label, value, tone }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong className={tone || ''}>{value}</strong>
    </div>
  )
}

function MetricPill({ icon: Icon, label, value, tone }) {
  return (
    <span className={`metric-pill ${tone || ''}`}>
      {Icon && <Icon size={14} />}
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  )
}

function HoldingChips({ fund }) {
  const holdings = mainHoldings(fund)

  if (!holdings.length) return <span className="empty-dash">-</span>

  return (
    <div className="holding-chips">
      {holdings.map((holding) => (
        <span
          key={`${holding.name}-${holding.weight}`}
          title={`${holding.country || '-'} / ${holding.sector || '-'} / 日涨跌 ${formatPercent(holding.dailyReturn)}`}
        >
          <strong>{holding.name}</strong>
          <em>{formatNumber(holding.weight)}%</em>
        </span>
      ))}
    </div>
  )
}

function PurchaseFeeBadge({ fund }) {
  const fee = fund.purchaseFee || {}
  const rate = effectiveFeeRate(fund)

  if (!Number.isFinite(rate)) return <span className="empty-dash">-</span>

  const title = [
    `当前费率 ${formatFeeRate(rate)}`,
    Number.isFinite(fee.officialRate) ? `官方费率 ${formatFeeRate(fee.officialRate)}` : '',
    fee.hasCurrentDiscount ? fee.discountTitle : '',
  ]
    .filter(Boolean)
    .join(' / ')

  return (
    <span className={`fee-badge ${fee.hasCurrentDiscount ? 'discount' : ''}`} title={title}>
      {formatFeeRate(rate)}
      {fee.hasCurrentDiscount && <em>折扣</em>}
    </span>
  )
}

function ExternalFundLinks({ fund }) {
  const links = [
    fund.links?.danjuan && { label: '雪球基金', href: fund.links.danjuan },
    fund.links?.tiantian && { label: '天天基金', href: fund.links.tiantian },
  ].filter(Boolean)

  if (!links.length) return null

  return (
    <div className="drawer-links">
      {links.map((link) => (
        <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
          {link.label}
          <ExternalLink size={13} />
        </a>
      ))}
    </div>
  )
}

function AllocationBars({ title, items }) {
  const visibleItems = (items || []).slice(0, 8)

  return (
    <div className="allocation-card">
      <h3>{title}</h3>
      {visibleItems.length ? (
        <div className="allocation-list">
          {visibleItems.map((item) => (
            <div className="allocation-row" key={item.label}>
              <span>{item.label}</span>
              <div className="allocation-track">
                <div style={{ width: `${Math.min(Math.max(item.weight, 0), 100)}%` }} />
              </div>
              <strong>{formatNumber(item.weight)}%</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-inline">-</div>
      )}
    </div>
  )
}

function FundHoldings({ holdings }) {
  const visibleHoldings = (holdings || []).slice(0, 4)

  return (
    <div className="allocation-card fund-holding-card">
      <div className="card-title-row">
        <h3>持有ETF / 目标基金</h3>
      </div>
      {visibleHoldings.length ? (
        <div className="fund-holding-list">
          {visibleHoldings.map((holding) => {
            const targetHoldings = (holding.targetHoldings || []).slice(0, 5)
            const weight = Number.isFinite(holding.weight) ? `${formatNumber(holding.weight)}%` : '-'
            return (
              <div className="fund-holding-item" key={`${holding.code}-${holding.name}`}>
                <div className="fund-holding-main">
                  <div>
                    {holding.targetSourceUrl ? (
                      <a href={holding.targetSourceUrl} target="_blank" rel="noreferrer">
                        {holding.name}
                        <ExternalLink size={12} />
                      </a>
                    ) : (
                      <strong>{holding.name}</strong>
                    )}
                    <span>
                      {holding.code || '-'}
                      {Number.isFinite(holding.dailyReturn) && ` / 日涨跌 ${formatPercent(holding.dailyReturn)}`}
                      {holding.lastUpdated && ` / 本基金更新 ${holding.lastUpdated}`}
                      {holding.targetLastUpdated && ` / ETF持仓更新 ${holding.targetLastUpdated}`}
                      {holding.estimatedWeight && ' / 占比待确认'}
                    </span>
                  </div>
                  <em>{weight}</em>
                </div>
                {targetHoldings.length ? (
                  <div className="target-holding-list">
                    {targetHoldings.map((target) => (
                      <div className="target-holding-row" key={`${holding.code}-${target.name}-${target.weight}`}>
                        <span>{target.name}</span>
                        <small>{target.country || '-'} / {target.sector || '-'}</small>
                        <b className={classForValue(target.dailyReturn)}>日涨跌 {formatPercent(target.dailyReturn)}</b>
                        <em>ETF内 {formatNumber(target.weight)}%</em>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="target-holding-empty">目标基金明细暂缺</div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="empty-inline">-</div>
      )}
    </div>
  )
}

function TopHoldings({ holdings, lastUpdated, lookThrough = false }) {
  const visibleHoldings = (holdings || []).slice(0, 6)

  return (
    <div className="allocation-card">
      <div className="card-title-row">
        <h3>{lookThrough ? '最终前十大持仓' : '前十大持仓'}</h3>
        {lastUpdated && <span>{lookThrough ? '穿透口径 / ' : ''}更新 {lastUpdated}</span>}
      </div>
      {visibleHoldings.length ? (
        <div className="holding-list">
          <div className="holding-header">
            <span>持仓</span>
            <span>日涨跌</span>
            <span>持仓占比</span>
          </div>
          {visibleHoldings.map((holding) => (
            <div className="holding-row" key={`${holding.name}-${holding.weight}`}>
              <strong>{holding.name}</strong>
              <span>{holding.country || '-'} / {holding.sector || '-'}</span>
              <b className={classForValue(holding.dailyReturn)}>{formatPercent(holding.dailyReturn)}</b>
              <em>{formatNumber(holding.weight)}%</em>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-inline">-</div>
      )}
    </div>
  )
}

function dateMs(date) {
  return new Date(`${date}T00:00:00Z`).getTime()
}

function chartX(date, startMs, endMs, width) {
  return ((dateMs(date) - startMs) / (endMs - startMs || 1)) * width
}

function chartPath(points, width, height, min, max, startMs, endMs) {
  return chartCoordinates(points, width, height, min, max, startMs, endMs)
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
}

function chartCoordinates(points, width, height, min, max, startMs, endMs) {
  const spread = max - min || 1
  return points.map((point) => {
    const x = chartX(point.date, startMs, endMs, width)
    const y = height - ((point.value - min) / spread) * (height - 28) - 14
    return {
      ...point,
      x,
      y,
    }
  })
}

function chartDateTicks(points, width, startMs, endMs, count = 5) {
  if (points.length < 2) return []

  const tickCount = Math.min(count, points.length)
  const spread = endMs - startMs || 1
  const ticks = []

  for (let index = 0; index < tickCount; index += 1) {
    const targetMs = startMs + (spread * index) / (tickCount - 1 || 1)
    const nearest = points.reduce((best, point) =>
      Math.abs(dateMs(point.date) - targetMs) < Math.abs(dateMs(best.date) - targetMs) ? point : best,
    points[0])

    ticks.push({
      date: nearest.date,
      x: chartX(nearest.date, startMs, endMs, width),
    })
  }

  return ticks.filter((tick, index) => index === 0 || tick.date !== ticks[index - 1].date)
}

function clampIndex(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function findSeriesValue(series, date) {
  return series.find((point) => point.date === date)?.value ?? null
}

function tooltipPosition(point, width) {
  const boxWidth = 138
  const x = point.x > width - boxWidth - 10 ? point.x - boxWidth - 10 : point.x + 10
  const y = Math.max(8, point.y - 56)

  return { x, y, width: boxWidth }
}

function ChartTooltip({ point, benchmarkSeries, performanceSeries, width }) {
  if (!point) return null

  const position = tooltipPosition(point, width)
  const benchmarkValue = findSeriesValue(benchmarkSeries, point.date)
  const performanceValue = findSeriesValue(performanceSeries, point.date)

  return (
    <g className="chart-tooltip">
      <rect x={position.x} y={position.y} width={position.width} height="70" rx="7" />
      <text x={position.x + 10} y={position.y + 18}>{point.date}</text>
      <text x={position.x + 10} y={position.y + 36}>本产品 {formatPercent(point.value)}</text>
      {Number.isFinite(benchmarkValue) && (
        <text x={position.x + 10} y={position.y + 52}>沪深300 {formatPercent(benchmarkValue)}</text>
      )}
      {Number.isFinite(performanceValue) && (
        <text x={position.x + 10} y={position.y + 66}>基准 {formatPercent(performanceValue)}</text>
      )}
    </g>
  )
}

function closestCoordinateIndex(coordinates, x) {
  if (!coordinates.length) return null

  let closestIndex = 0
  let closestDistance = Math.abs(coordinates[0].x - x)
  for (let index = 1; index < coordinates.length; index += 1) {
    const distance = Math.abs(coordinates[index].x - x)
    if (distance < closestDistance) {
      closestIndex = index
      closestDistance = distance
    }
  }

  return closestIndex
}

function svgPointerX(event, width) {
  const svg = event.currentTarget
  const matrix = svg.getScreenCTM?.()

  if (matrix && typeof svg.createSVGPoint === 'function') {
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    return point.matrixTransform(matrix.inverse()).x
  }

  const bounds = svg.getBoundingClientRect()
  return ((event.clientX - bounds.left) / bounds.width) * width
}

function periodCardReturn(metrics, history, xueqiuReturns, periodKey) {
  if (metrics?.intervals) {
    const metricValue = metrics.intervals[periodKey]?.totalReturn
    return Number.isFinite(metricValue) ? metricValue : null
  }

  if (xueqiuReturns && Object.keys(xueqiuReturns).length) {
    const xueqiuValue = xueqiuReturns[periodKey]
    return Number.isFinite(xueqiuValue) ? xueqiuValue : null
  }

  const xueqiuValue = xueqiuReturns?.[periodKey]
  return Number.isFinite(xueqiuValue) ? xueqiuValue : periodReturn(history, periodKey)
}

function PerformanceChart({
  history,
  growthSeries,
  xueqiuReturns,
  metrics,
  periodKey,
  onPeriodChange,
  fundName = '本产品',
}) {
  const [hoverIndex, setHoverIndex] = useState(null)
  const xueqiuSeries = resetGrowthSeries(unpackGrowthSeries(growthSeries), periodKey)
  const metric = metrics?.intervals?.[periodKey] || null
  const productSeries = normalizedReturnSeries(history, periodKey)
  const startDate = productSeries[0]?.date
  const endDate = productSeries.at(-1)?.date
  const startMs = startDate ? dateMs(startDate) : null
  const endMs = endDate ? dateMs(endDate) : null
  const benchmarkSeries = xueqiuSeries
    .filter((point) => Number.isFinite(point.benchmarkValue) && dateMs(point.date) >= startMs && dateMs(point.date) <= endMs)
    .map((point) => ({ date: point.date, value: point.benchmarkValue }))
  const performanceSeries = xueqiuSeries
    .filter((point) => Number.isFinite(point.performanceValue) && dateMs(point.date) >= startMs && dateMs(point.date) <= endMs)
    .map((point) => ({ date: point.date, value: point.performanceValue }))

  if (productSeries.length < 2 || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs === endMs) {
    return <div className="empty-chart">暂无走势</div>
  }

  const width = 720
  const height = 260
  const values = [...productSeries, ...benchmarkSeries, ...performanceSeries].map((point) => point.value)
  const rawMin = Math.min(0, ...values)
  const rawMax = Math.max(0, ...values)
  const padding = Math.max((rawMax - rawMin) * 0.12, 0.02)
  const min = rawMin - padding
  const max = rawMax + padding
  const zeroY = height - ((0 - min) / (max - min || 1)) * (height - 28) - 14
  const productPath = chartPath(productSeries, width, height, min, max, startMs, endMs)
  const benchmarkPath = benchmarkSeries.length ? chartPath(benchmarkSeries, width, height, min, max, startMs, endMs) : ''
  const performancePath = performanceSeries.length ? chartPath(performanceSeries, width, height, min, max, startMs, endMs) : ''
  const productReturn = Number.isFinite(metric?.totalReturn) ? metric.totalReturn : productSeries.at(-1)?.value
  const benchmarkReturn = benchmarkSeries.at(-1)?.value
  const performanceReturn = performanceSeries.at(-1)?.value
  const yTicks = [max, (max + min) / 2, 0, min]
  const productCoordinates = chartCoordinates(productSeries, width, height, min, max, startMs, endMs)
  const hoverPoint = Number.isInteger(hoverIndex) ? productCoordinates[hoverIndex] : null
  const dateTicks = chartDateTicks(productSeries, width, startMs, endMs)
  const handlePointerMove = (event) => {
    const x = Math.min(Math.max(svgPointerX(event, width), 0), width)
    const closestIndex = closestCoordinateIndex(productCoordinates, x)
    setHoverIndex(closestIndex === null ? null : clampIndex(closestIndex, 0, productSeries.length - 1))
  }

  return (
    <div className="performance-card">
      <div className="performance-head">
        <h3>业绩曲线</h3>
        <div className="performance-legend">
          <span className="legend-product">{fundName} <strong className={classForValue(productReturn)}>{formatPercent(productReturn)}</strong></span>
          {benchmarkSeries.length ? (
            <span className="legend-benchmark">沪深300指数 <strong className={classForValue(benchmarkReturn)}>{formatPercent(benchmarkReturn)}</strong></span>
          ) : null}
          {performanceSeries.length ? (
            <span className="legend-performance">业绩比较基准 <strong className={classForValue(performanceReturn)}>{formatPercent(performanceReturn)}</strong></span>
          ) : null}
        </div>
      </div>
      <div className="performance-chart-shell">
        <div className="chart-yaxis">
          {yTicks.map((tick) => (
            <span key={tick.toFixed(6)}>{formatPercent(tick)}</span>
          ))}
        </div>
        <svg
          className="performance-chart"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="区间业绩曲线"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
        >
          <path d={`M0 ${zeroY.toFixed(2)} H${width}`} className="chart-zero" />
          {dateTicks.map((tick) => (
            <path key={tick.date} d={`M${tick.x.toFixed(2)} ${height - 18} V${height - 8}`} className="chart-tick" />
          ))}
          <path d={`${productPath} L${width} ${zeroY.toFixed(2)} L0 ${zeroY.toFixed(2)} Z`} className="chart-area" />
          {benchmarkPath && <path d={benchmarkPath} className="chart-line benchmark" />}
          {performancePath && <path d={performancePath} className="chart-line performance" />}
          <path d={productPath} className="chart-line product" />
          {hoverPoint && (
            <>
              <path d={`M${hoverPoint.x.toFixed(2)} 8 V${height - 8}`} className="chart-hover-line" />
              <circle cx={hoverPoint.x} cy={hoverPoint.y} r="4.2" className="chart-hover-dot" />
              <ChartTooltip
                point={hoverPoint}
                benchmarkSeries={benchmarkSeries}
                performanceSeries={performanceSeries}
                width={width}
              />
            </>
          )}
          <rect className="chart-hitbox" x="0" y="0" width={width} height={height} />
        </svg>
      </div>
      <div className="chart-dates">
        {dateTicks.map((tick) => (
          <span key={tick.date} style={{ left: `${(tick.x / width) * 100}%` }}>{tick.date}</span>
        ))}
      </div>
      <div className="performance-period-cards">
        {PERFORMANCE_CARD_PERIODS.map((period) => {
          const value = periodCardReturn(metrics, history, xueqiuReturns, period.key)
          return (
            <button
              key={period.key}
              className={periodKey === period.key ? 'active' : ''}
              type="button"
              onClick={() => onPeriodChange?.(period.key)}
            >
              <span>{period.label}</span>
              <strong className={classForValue(value)}>{formatPercent(value)}</strong>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FundPerformanceTable({ history }) {
  const rows = dailyRows(history).slice(-5).reverse()

  return (
    <div className="fund-performance-table">
      <div className="card-title-row">
        <h3>基金业绩</h3>
      </div>
      <div className="fund-performance-head">
        <span>日期</span>
        <span>净值</span>
        <span>日涨跌</span>
      </div>
      {rows.length ? (
        <div className="fund-performance-list">
          {rows.map((row) => (
            <div className="fund-performance-row" key={row.date}>
              <strong>{row.date}</strong>
              <span>{formatNumber(row.value, 4)}</span>
              <em className={classForValue(row.dailyReturn)}>{formatPercent(row.dailyReturn)}</em>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-inline">-</div>
      )}
    </div>
  )
}

function fundMatchesToken(fund, token) {
  return fund.id?.includes(token) || fund.isin?.includes(token) || fund.name?.includes(token)
}

function createDefaultPortfolioRows(funds = []) {
  return DEFAULT_PORTFOLIO_ROWS.map((item, index) => {
    const fund = funds.find((candidate) => fundMatchesToken(candidate, item.token))
    return {
      id: `default-${index}-${item.token}`,
      fundId: fund?.id || '',
      amount: String(item.amount),
    }
  }).filter((row) => row.fundId)
}

function pointAtOrBefore(points, date) {
  let current = null
  for (const point of points) {
    if (point.date > date) break
    current = point
  }
  return current
}

function pointAtOrAfter(points, date) {
  return points.find((point) => point.date >= date) || null
}

function portfolioFundOptions(funds = []) {
  return [...funds]
    .filter((fund) => fund.localMetrics?.pointCount > 1 || fund.historyCny?.length > 1)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

function suggestedPortfolioStartDate(rows, fundsById) {
  const latestDates = rows
    .map((row) => fundsById.get(row.fundId))
    .map((fund) => portfolioHistoryFor(fund || {}).at(-1)?.date)
    .filter(Boolean)
    .sort()

  if (!latestDates.length) return ''
  return shiftDate(latestDates[0], 6, 'month')
}

function annualizedVolatilityFromSeries(series) {
  if (series.length < 3) return null

  const returns = []
  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1].totalValue
    if (previous > 0) returns.push(series[index].totalValue / previous - 1)
  }

  if (returns.length < 2) return null
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance) * Math.sqrt(252)
}

function buildPortfolioAnalysis(rows, fundsById, startDate) {
  const requestedRows = rows
    .map((row) => {
      const fund = fundsById.get(row.fundId)
      const amount = Number(row.amount)
      const points = portfolioHistoryFor(fund || {})
        .filter((point) => point.date && Number.isFinite(point.value) && point.value > 0)
        .sort((a, b) => a.date.localeCompare(b.date))

      return {
        row,
        fund,
        amount,
        points,
        startPoint: startDate ? pointAtOrAfter(points, startDate) : null,
        lastPoint: points.at(-1) || null,
      }
    })
    .filter((item) => item.fund && Number.isFinite(item.amount) && item.amount > 0)

  const unavailableRows = requestedRows.filter((item) => !item.startPoint || !item.lastPoint)
  const availableRows = requestedRows.filter((item) => item.startPoint && item.lastPoint)

  if (!startDate || !availableRows.length) {
    return {
      positions: [],
      unavailableRows,
      returnSeries: [],
      totalAmount: requestedRows.reduce((sum, item) => sum + item.amount, 0),
      totalFee: 0,
      netInvested: 0,
      currentValue: null,
      startDate: '',
      endDate: '',
    }
  }

  const commonStart = availableRows
    .map((item) => item.startPoint.date)
    .sort()
    .at(-1)
  const commonEnd = availableRows
    .map((item) => item.lastPoint.date)
    .sort()[0]

  if (!commonStart || !commonEnd || commonStart >= commonEnd) {
    return {
      positions: [],
      unavailableRows,
      returnSeries: [],
      totalAmount: requestedRows.reduce((sum, item) => sum + item.amount, 0),
      totalFee: 0,
      netInvested: 0,
      currentValue: null,
      startDate: commonStart || '',
      endDate: commonEnd || '',
    }
  }

  const positions = availableRows.map((item) => {
    const feeRate = effectiveFeeRate(item.fund)
    const appliedFeeRate = Number.isFinite(feeRate) ? feeRate : 0
    const fee = item.amount - item.amount / (1 + appliedFeeRate)
    const netAmount = item.amount - fee
    const buyPoint = pointAtOrBefore(item.points, commonStart) || pointAtOrAfter(item.points, commonStart)
    const units = buyPoint ? netAmount / buyPoint.value : 0

    return {
      fund: item.fund,
      amount: item.amount,
      feeRate,
      fee,
      netAmount,
      buyDate: buyPoint?.date || commonStart,
      buyValue: buyPoint?.value ?? null,
      points: item.points,
      units,
    }
  }).filter((position) => position.units > 0)

  const totalAmount = positions.reduce((sum, position) => sum + position.amount, 0)
  const totalFee = positions.reduce((sum, position) => sum + position.fee, 0)
  const netInvested = totalAmount - totalFee
  const dateSet = new Set([commonStart])

  for (const position of positions) {
    for (const point of position.points) {
      if (point.date >= commonStart && point.date <= commonEnd) dateSet.add(point.date)
    }
  }

  const valueSeries = [...dateSet]
    .sort()
    .map((date) => {
      const totalValue = positions.reduce((sum, position) => {
        const point = pointAtOrBefore(position.points, date)
        return point ? sum + position.units * point.value : sum
      }, 0)

      return {
        date,
        totalValue,
        value: totalAmount > 0 ? totalValue / totalAmount - 1 : null,
      }
    })
    .filter((point) => Number.isFinite(point.totalValue) && point.totalValue > 0 && Number.isFinite(point.value))

  const endPoint = valueSeries.at(-1)
  const initialPoint = valueSeries[0]
  const currentValue = endPoint?.totalValue ?? null
  const holdingDays = initialPoint && endPoint ? daysBetween(initialPoint.date, endPoint.date) : null
  const afterFeeReturn = Number.isFinite(currentValue) && totalAmount > 0 ? currentValue / totalAmount - 1 : null
  const marketReturn = Number.isFinite(currentValue) && netInvested > 0 ? currentValue / netInvested - 1 : null
  const annualizedReturn =
    Number.isFinite(afterFeeReturn) && Number.isFinite(holdingDays) && holdingDays > 0
      ? (currentValue / totalAmount) ** (365 / holdingDays) - 1
      : null
  const annualizedVolatility = annualizedVolatilityFromSeries(valueSeries)
  const drawdown = computeMaxDrawdown(valueSeries.map((point) => ({ date: point.date, value: point.totalValue })))
  const breakEvenPoint = valueSeries.find((point) => point.totalValue >= totalAmount)

  return {
    positions,
    unavailableRows,
    returnSeries: valueSeries.map((point) => ({ date: point.date, value: point.value, totalValue: point.totalValue })),
    totalAmount,
    totalFee,
    netInvested,
    currentValue,
    afterFeeReturn,
    marketReturn,
    annualizedReturn,
    annualizedVolatility,
    drawdown,
    feeBreakEvenDate: breakEvenPoint?.date || null,
    feeBreakEvenDays: breakEvenPoint ? daysBetween(initialPoint.date, breakEvenPoint.date) : null,
    startDate: initialPoint?.date || commonStart,
    endDate: endPoint?.date || commonEnd,
  }
}

function currencyAmount(value) {
  if (!Number.isFinite(value)) return '-'
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

function PortfolioChartTooltip({ point, width }) {
  if (!point) return null

  const position = tooltipPosition(point, width)
  return (
    <g className="chart-tooltip">
      <rect x={position.x} y={position.y} width={position.width} height="54" rx="7" />
      <text x={position.x + 10} y={position.y + 18}>{point.date}</text>
      <text x={position.x + 10} y={position.y + 36}>累计收益 {formatPercent(point.value)}</text>
      <text x={position.x + 10} y={position.y + 52}>市值 {currencyAmount(point.totalValue)}</text>
    </g>
  )
}

function PortfolioReturnChart({ points }) {
  const [hoverIndex, setHoverIndex] = useState(null)

  if (points.length < 2) return <div className="empty-chart">选择买入日期后显示组合走势</div>

  const width = 720
  const height = 230
  const startMs = dateMs(points[0].date)
  const endMs = dateMs(points.at(-1).date)
  const values = points.map((point) => point.value)
  const rawMin = Math.min(0, ...values)
  const rawMax = Math.max(0, ...values)
  const padding = Math.max((rawMax - rawMin) * 0.12, 0.01)
  const min = rawMin - padding
  const max = rawMax + padding
  const zeroY = height - ((0 - min) / (max - min || 1)) * (height - 28) - 14
  const path = chartPath(points, width, height, min, max, startMs, endMs)
  const coordinates = chartCoordinates(points, width, height, min, max, startMs, endMs)
  const hoverPoint = Number.isInteger(hoverIndex) ? coordinates[hoverIndex] : null
  const dateTicks = chartDateTicks(points, width, startMs, endMs)
  const yTicks = [max, (max + min) / 2, 0, min]
  const handlePointerMove = (event) => {
    const x = Math.min(Math.max(svgPointerX(event, width), 0), width)
    const closestIndex = closestCoordinateIndex(coordinates, x)
    setHoverIndex(closestIndex === null ? null : clampIndex(closestIndex, 0, points.length - 1))
  }

  return (
    <div className="portfolio-chart-card">
      <div className="performance-chart-shell">
        <div className="chart-yaxis">
          {yTicks.map((tick) => (
            <span key={tick.toFixed(6)}>{formatPercent(tick)}</span>
          ))}
        </div>
        <svg
          className="performance-chart"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="组合累计收益曲线"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
        >
          <path d={`M0 ${zeroY.toFixed(2)} H${width}`} className="chart-zero" />
          {dateTicks.map((tick) => (
            <path key={tick.date} d={`M${tick.x.toFixed(2)} ${height - 18} V${height - 8}`} className="chart-tick" />
          ))}
          <path d={`${path} L${width} ${zeroY.toFixed(2)} L0 ${zeroY.toFixed(2)} Z`} className="chart-area" />
          <path d={path} className="chart-line product" />
          {hoverPoint && (
            <>
              <path d={`M${hoverPoint.x.toFixed(2)} 8 V${height - 8}`} className="chart-hover-line" />
              <circle cx={hoverPoint.x} cy={hoverPoint.y} r="4.2" className="chart-hover-dot" />
              <PortfolioChartTooltip point={hoverPoint} width={width} />
            </>
          )}
          <rect className="chart-hitbox" x="0" y="0" width={width} height={height} />
        </svg>
      </div>
      <div className="chart-dates">
        {dateTicks.map((tick) => (
          <span key={tick.date} style={{ left: `${(tick.x / width) * 100}%` }}>{tick.date}</span>
        ))}
      </div>
    </div>
  )
}

function PortfolioBuilder({ data, onOpenFund }) {
  const funds = data.funds
  const fundOptions = useMemo(() => portfolioFundOptions(funds), [funds])
  const fundsById = useMemo(() => new Map(funds.map((fund) => [fund.id, fund])), [funds])
  const [rows, setRows] = useState([])
  const [startDate, setStartDate] = useState('')
  const suggestedStart = useMemo(() => suggestedPortfolioStartDate(rows, fundsById), [fundsById, rows])
  const analysis = useMemo(() => buildPortfolioAnalysis(rows, fundsById, startDate), [fundsById, rows, startDate])
  const totalInputAmount = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0)
  const analysisDays = daysBetween(analysis.startDate, analysis.endDate)
  const isCompactRange = Number.isFinite(analysisDays) && analysisDays < 270

  useEffect(() => {
    if (!funds.length || rows.length) return
    setRows(createDefaultPortfolioRows(funds))
  }, [funds, rows.length])

  useEffect(() => {
    if (!suggestedStart || startDate) return
    setStartDate(suggestedStart)
  }, [startDate, suggestedStart])

  const resetPortfolio = () => {
    setRows(createDefaultPortfolioRows(funds))
    setStartDate('')
  }
  const addRow = () => {
    setRows((current) => [
      ...current,
      { id: `custom-${Date.now()}`, fundId: fundOptions[0]?.id || '', amount: '' },
    ])
  }
  const updateRow = (id, patch) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }
  const removeRow = (id) => {
    setRows((current) => current.filter((row) => row.id !== id))
  }

  return (
    <section className="portfolio-tool">
      <div className="portfolio-head">
        <div>
          <p className="eyebrow">自定义配置组合</p>
          <h2>组合回测</h2>
          <p>金额按含申购费扣款处理，曲线使用人民币视角历史净值；默认组合为 50 万推荐配置。</p>
        </div>
        <div className="portfolio-actions">
          <label className="date-control">
            <span><CalendarDays size={14} />买入日期</span>
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <button className="outline-button" type="button" onClick={resetPortfolio}>
            <RotateCcw size={15} />
            恢复推荐
          </button>
          <button className="source-link" type="button" onClick={addRow}>
            <Plus size={15} />
            添加基金
          </button>
        </div>
      </div>

      <div className={isCompactRange ? 'portfolio-visual compact' : 'portfolio-visual'}>
        <div className="portfolio-metrics">
          <MetricPill icon={PieChart} label="配置金额" value={`${currencyAmount(totalInputAmount)}元`} />
          <MetricPill icon={Check} label="申购费估算" value={`${currencyAmount(analysis.totalFee)}元`} />
          <MetricPill icon={TrendingUp} label="累计收益" value={formatPercent(analysis.afterFeeReturn)} tone={classForValue(analysis.afterFeeReturn)} />
          <MetricPill icon={BarChart3} label="年化" value={formatPercent(analysis.annualizedReturn)} tone={classForValue(analysis.annualizedReturn)} />
          <MetricPill icon={ArrowDown} label="最大回撤" value={formatPercent(analysis.drawdown?.maxDrawdown)} tone={classForValue(analysis.drawdown?.maxDrawdown)} />
          <MetricPill icon={Clock3} label="申购费回本" value={analysis.feeBreakEvenDate ? `${analysis.feeBreakEvenDate} / ${formatDays(analysis.feeBreakEvenDays)}` : '-'} />
        </div>

        <PortfolioReturnChart points={analysis.returnSeries} />
      </div>

      <div className="portfolio-body">
        <div className="portfolio-editor">
          <div className="card-title-row">
            <h3>配置明细</h3>
            <span>默认 {currencyAmount(DEFAULT_PORTFOLIO_TOTAL)} 元，可直接改金额和基金</span>
          </div>
          <div className="portfolio-row header">
            <span>基金</span>
            <span>买入金额</span>
            <span>费率</span>
            <span>操作</span>
          </div>
          {rows.map((row) => {
            const fund = fundsById.get(row.fundId)
            return (
              <div className="portfolio-row" key={row.id}>
                <select value={row.fundId} onChange={(event) => updateRow(row.id, { fundId: event.target.value })}>
                  {fundOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="0"
                  step="1000"
                  value={row.amount}
                  onChange={(event) => updateRow(row.id, { amount: event.target.value })}
                />
                <strong>{formatFeeRate(effectiveFeeRate(fund || {}))}</strong>
                <button className="icon-button" type="button" onClick={() => removeRow(row.id)} title="删除">
                  <Trash2 size={15} />
                </button>
              </div>
            )
          })}
          {analysis.unavailableRows.length ? (
            <p className="portfolio-warning">
              有 {analysis.unavailableRows.length} 项在该买入日期之后缺少历史净值，已暂不计入曲线。
            </p>
          ) : null}
        </div>

        <div className="portfolio-breakdown">
          <div className="card-title-row">
            <h3>回测口径</h3>
            <span>{analysis.startDate || '-'} - {analysis.endDate || '-'}</span>
          </div>
          <dl className="detail-list">
            <dt>扣款金额</dt>
            <dd>{currencyAmount(analysis.totalAmount)} 元</dd>
            <dt>实际入市</dt>
            <dd>{currencyAmount(analysis.netInvested)} 元</dd>
            <dt>当前市值</dt>
            <dd>{currencyAmount(analysis.currentValue)} 元</dd>
            <dt>不含费市场涨跌</dt>
            <dd className={classForValue(analysis.marketReturn)}>{formatPercent(analysis.marketReturn)}</dd>
            <dt>波动率</dt>
            <dd>{formatPercent(analysis.annualizedVolatility)}</dd>
            <dt>回撤低点</dt>
            <dd>{analysis.drawdown?.troughDate || '-'}</dd>
          </dl>
          <div className="portfolio-position-list">
            {analysis.positions.map((position) => (
              <button key={position.fund.id} type="button" onClick={() => onOpenFund(position.fund)}>
                <span>{position.fund.name}</span>
                <strong>{formatPercent(position.amount / (analysis.totalAmount || 1), 1)}</strong>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function SummaryPanel({ data }) {
  return (
    <aside className="summary-panel">
      <div className="summary-head">
        <div>
          <p className="eyebrow">渣打中国代客理财与基金</p>
          <h1>基金筛选看板</h1>
        </div>
        <a className="icon-link" href={DATA_URL} download title="下载数据 JSON">
          <Download size={18} />
        </a>
      </div>

      <div className="summary-grid">
        <Stat label="产品总数" value={data.summary.total} />
        <Stat label="有历史曲线" value={data.summary.withHistory} />
        <Stat label="外币产品" value={data.summary.total - (data.summary.byCurrency['人民币'] || 0)} />
        <Stat label="当月费率折扣" value={data.summary.withCurrentFeeDiscount || 0} />
      </div>

      <section className="panel-section">
        <h2>类型概览</h2>
        <div className="type-bars">
          {Object.entries(data.summary.byType).map(([label, count]) => (
            <div className="bar-row" key={label}>
              <span>{label}</span>
              <div className="bar-track">
                <div style={{ width: `${(count / data.summary.total) * 100}%` }} />
              </div>
              <strong>{count}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-section">
        <h2>币种风险</h2>
        <div className="currency-list">
          {Object.entries(data.summary.byCurrency).map(([label, count]) => (
            <span key={label} className={label === '人民币' ? '' : 'warn'}>
              {label} {count}
            </span>
          ))}
        </div>
        <p className="panel-note">
          外币产品同时计算原币收益和按历史汇率折算后的人民币收益，推荐和排序默认使用人民币视角。
        </p>
      </section>

      <section className="panel-section">
        <h2>数据说明</h2>
        <p className="panel-note">
          渣打清单更新时间 {data.sourceInfo['date-modified'] || '-'}。境外产品走势来自渣打 Morningstar
          GraphQL；境内公募净值、业绩曲线、持仓和日涨跌来自雪球/蛋卷公开接口，申购费按基金官方原费率并结合渣打当月折扣公告计算。
        </p>
      </section>
    </aside>
  )
}

function FundTable({ funds, viewMode, periodKey, sort, onSort, onOpenFund }) {
  const sortableHeader = (label, key, align = '') => (
    <button className={`sort-header ${align}`} type="button" onClick={() => onSort(key)}>
      {label}
      {sort.key === key ? sort.direction === 'desc' ? <ArrowDown size={13} /> : <ArrowUp size={13} /> : null}
    </button>
  )

  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>{sortableHeader('基金', 'name')}</th>
            <th>主要持仓</th>
            <th>类型</th>
            <th>币种</th>
            <th>{sortableHeader('日涨跌', 'daily', 'right')}</th>
            <th>{sortableHeader('区间涨跌', 'return', 'right')}</th>
            <th>{sortableHeader('年化', 'annualized', 'right')}</th>
            <th>{sortableHeader('夏普', 'sharpe', 'right')}</th>
            <th>{sortableHeader('最大回撤', 'drawdown', 'right')}</th>
            <th>{sortableHeader('修复', 'recovery', 'right')}</th>
            <th>{sortableHeader('申购费', 'feeRate', 'right')}</th>
            <th>{sortableHeader('回本', 'fee', 'right')}</th>
          </tr>
        </thead>
        <tbody>
          {funds.map((fund) => {
            const metric = metricFor(fund, viewMode, periodKey)
            const recoveryDays = metric?.drawdown?.recoveryDays ?? metric?.drawdown?.unrecoveredDays
            const hasHistory = fund.localMetrics.pointCount > 1
            const dailyReturn = latestDailyReturn(historyFor(fund, viewMode))
            return (
              <tr key={fund.id} onClick={() => onOpenFund(fund)}>
                <td>
                  <div className="fund-cell">
                    <strong>{fund.name}</strong>
                    <span>{fund.house || '-'} / {fund.sector || '-'} / {fund.isin}</span>
                  </div>
                </td>
                <td>
                  <HoldingChips fund={fund} />
                </td>
                <td>
                  <span className="tag">{fund.typeLabel}</span>
                </td>
                <td>
                  <span className={isForeignCurrency(fund) ? 'currency warn' : 'currency'}>
                    {fund.currency}
                    {isForeignCurrency(fund) && <AlertTriangle size={12} />}
                  </span>
                </td>
                <td className={`number ${classForValue(dailyReturn)}`}>{formatPercent(dailyReturn)}</td>
                <td className={`number ${classForValue(metric?.totalReturn)}`}>{formatPercent(metric?.totalReturn)}</td>
                <td className={`number ${classForValue(metric?.annualizedReturn)}`}>
                  {formatPercent(metric?.annualizedReturn)}
                </td>
                <td className="number">{formatNumber(metric?.sharpe)}</td>
                <td className={`number ${classForValue(metric?.maxDrawdown)}`}>{formatPercent(metric?.maxDrawdown)}</td>
                <td className="number">
                  {metric?.drawdown?.recovered === false && Number.isFinite(recoveryDays) ? '未修复 ' : ''}
                  {formatDays(recoveryDays)}
                </td>
                <td className="number"><PurchaseFeeBadge fund={fund} /></td>
                <td className="number">{hasHistory ? formatDays(metric?.feeBreakEvenDays) : '-'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PeriodMetrics({ fund, viewMode }) {
  const metrics = viewMode === 'cny' ? fund.cnyMetrics : fund.localMetrics

  return (
    <div className="interval-table">
      <table>
        <thead>
          <tr>
            <th>区间</th>
            <th>起止日期</th>
            <th>涨跌幅</th>
            <th>年化</th>
            <th>夏普</th>
            <th>最大回撤</th>
            <th>修复天数</th>
            <th>申购费回本</th>
          </tr>
        </thead>
        <tbody>
          {PERIODS.map((period) => {
            const metric = metrics?.intervals?.[period.key]
            const recoveryDays = metric?.drawdown?.recoveryDays ?? metric?.drawdown?.unrecoveredDays
            return (
              <tr key={period.key}>
                <td>{period.label}</td>
                <td>{metric ? `${metric.startDate} - ${metric.endDate}` : '-'}</td>
                <td className={classForValue(metric?.totalReturn)}>{formatPercent(metric?.totalReturn)}</td>
                <td className={classForValue(metric?.annualizedReturn)}>{formatPercent(metric?.annualizedReturn)}</td>
                <td>{formatNumber(metric?.sharpe)}</td>
                <td className={classForValue(metric?.maxDrawdown)}>{formatPercent(metric?.maxDrawdown)}</td>
                <td>{metric?.drawdown?.recovered === false && Number.isFinite(recoveryDays) ? '未修复 ' : ''}{formatDays(recoveryDays)}</td>
                <td>{formatDays(metric?.feeBreakEvenDays)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FundDrawer({ fund, onClose }) {
  const [periodKey, setPeriodKey] = useState(DEFAULT_PERIOD)
  const [viewMode, setViewMode] = useState(isForeignCurrency(fund) && fund.historyCny?.length ? 'cny' : 'local')
  const metric = metricFor(fund, viewMode, periodKey)
  const navHistory = historyFor(fund, viewMode)
  const returnHistory = returnHistoryFor(fund, viewMode)
  const localMetric = metricFor(fund, 'local', periodKey)
  const cnyMetric = metricFor(fund, 'cny', periodKey)
  const fxImpact =
    isForeignCurrency(fund) && Number.isFinite(localMetric?.totalReturn) && Number.isFinite(cnyMetric?.totalReturn)
      ? cnyMetric.totalReturn - localMetric.totalReturn
      : null
  const purchaseFee = fund.purchaseFee || {}
  const dailyReturn = latestDailyReturn(navHistory)

  useEffect(() => {
    setViewMode(isForeignCurrency(fund) && fund.historyCny?.length ? 'cny' : 'local')
    setPeriodKey(DEFAULT_PERIOD)
  }, [fund])

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <p className="eyebrow">{fund.typeLabel} / {fund.currency} / {fund.isin}</p>
            <h2>{fund.name}</h2>
            <p>{fund.house || '-'} / {fund.assetClass || '-'} / {fund.sector || '-'}</p>
            <ExternalFundLinks fund={fund} />
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="drawer-tools">
          <div className="segmented">
            <button className={viewMode === 'local' ? 'active' : ''} type="button" onClick={() => setViewMode('local')}>
              原币
            </button>
            <button
              className={viewMode === 'cny' ? 'active' : ''}
              type="button"
              disabled={!fund.historyCny?.length && isForeignCurrency(fund)}
              onClick={() => setViewMode('cny')}
            >
              人民币
            </button>
          </div>
        </div>

        <section className="drawer-section">
          <div className="metric-row">
            <MetricPill
              icon={TrendingUp}
              label="日涨跌"
              value={formatPercent(dailyReturn)}
              tone={classForValue(dailyReturn)}
            />
            <MetricPill
              icon={TrendingUp}
              label={`${PERIOD_LABELS[periodKey]}涨跌`}
              value={formatPercent(metric?.totalReturn)}
              tone={classForValue(metric?.totalReturn)}
            />
            <MetricPill icon={BarChart3} label="年化" value={formatPercent(metric?.annualizedReturn)} tone={classForValue(metric?.annualizedReturn)} />
            <MetricPill icon={Gauge} label="夏普" value={formatNumber(metric?.sharpe)} />
            <MetricPill icon={ArrowDown} label="最大回撤" value={formatPercent(metric?.maxDrawdown)} tone={classForValue(metric?.maxDrawdown)} />
            <MetricPill
              icon={Clock3}
              label="回撤修复"
              value={`${metric?.drawdown?.recovered === false ? '未修复 ' : ''}${formatDays(metric?.drawdown?.recoveryDays ?? metric?.drawdown?.unrecoveredDays)}`}
            />
            <MetricPill icon={Check} label="申购费回本" value={formatDays(metric?.feeBreakEvenDays)} />
          </div>

          {isForeignCurrency(fund) && (
            <div className="fx-note">
              <AlertTriangle size={16} />
              <span>
                {fund.currency} 计价，人民币投资者承受汇率风险。
                {Number.isFinite(fxImpact)
                  ? `本区间汇率折算影响约 ${formatPercent(fxImpact)}。`
                  : '当前区间缺少可比汇率数据。'}
              </span>
            </div>
          )}

          <PerformanceChart
            history={returnHistory}
            periodKey={periodKey}
            growthSeries={!isForeignCurrency(fund) ? fund.growthSeries : []}
            xueqiuReturns={!isForeignCurrency(fund) ? fund.xueqiuReturns : null}
            metrics={viewMode === 'cny' ? fund.cnyMetrics : fund.localMetrics}
            fundName="本产品"
            onPeriodChange={setPeriodKey}
          />
          <FundPerformanceTable history={navHistory} />
        </section>

        <section className="drawer-section">
          <div className="section-title-row">
            <h3>持仓分布</h3>
            {fund.holdingProfile?.lastUpdated && <span>更新 {fund.holdingProfile.lastUpdated}</span>}
          </div>
          <div className="allocation-grid">
            {fund.holdingProfile?.fundHoldings?.length ? (
              <FundHoldings holdings={fund.holdingProfile.fundHoldings} />
            ) : null}
            <AllocationBars title="持仓地区" items={fund.holdingProfile?.geography} />
            <AllocationBars title="持仓行业" items={fund.holdingProfile?.sector} />
            <AllocationBars title="资产配置" items={fund.holdingProfile?.asset} />
            <TopHoldings
              holdings={displayHoldings(fund)}
              lastUpdated={fund.holdingProfile?.lastUpdated}
              lookThrough={hasLookThroughHoldings(fund)}
            />
          </div>
        </section>

        <section className="drawer-section">
          <h3>历史区间数据</h3>
          <PeriodMetrics fund={fund} viewMode={viewMode} />
        </section>

        <section className="drawer-section two-columns">
          <div>
            <h3>最大回撤</h3>
            <dl className="detail-list">
              <dt>峰值日期</dt>
              <dd>{metric?.drawdown?.peakDate || '-'}</dd>
              <dt>低点日期</dt>
              <dd>{metric?.drawdown?.troughDate || '-'}</dd>
              <dt>修复日期</dt>
              <dd>{metric?.drawdown?.recoveryDate || (metric?.drawdown ? '尚未修复' : '-')}</dd>
            </dl>
          </div>
          <div>
            <h3>申购费回本</h3>
            <dl className="detail-list">
              <dt>当前申购费</dt>
              <dd>{formatFeeRate(purchaseFee.effectiveRate)}</dd>
              <dt>官方申购费</dt>
              <dd>{formatFeeRate(purchaseFee.officialRate)}</dd>
              <dt>当月折扣</dt>
              <dd>{purchaseFee.hasCurrentDiscount ? `1折 ${purchaseFee.discountMonth || ''}` : '-'}</dd>
              <dt>折扣公告</dt>
              <dd>
                {purchaseFee.discountUrl ? (
                  <a href={purchaseFee.discountUrl} target="_blank" rel="noreferrer">{purchaseFee.discountTitle || '查看公告'}</a>
                ) : '-'}
              </dd>
              <dt>本区间回本日期</dt>
              <dd>{metric?.feeBreakEvenDate || '-'}</dd>
              <dt>滚动回本成功率</dt>
              <dd>{formatPercent(fund[viewMode === 'cny' ? 'cnyMetrics' : 'localMetrics']?.rollingFeeRecovery?.successRate)}</dd>
            </dl>
          </div>
        </section>
      </aside>
    </div>
  )
}

function App() {
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [selectedFund, setSelectedFund] = useState(null)
  const [activeTab, setActiveTab] = useState('funds')
  const [query, setQuery] = useState('')
  const [periodKey, setPeriodKey] = useState(DEFAULT_PERIOD)
  const [viewMode, setViewMode] = useState('cny')
  const [colorMode, setColorMode] = useState('a-share')
  const [filters, setFilters] = useState({
    type: 'all',
    currency: 'all',
    assetClass: 'all',
    sector: 'all',
    minAnnualized: '',
    maxDrawdown: '',
    maxRecoveryDays: '',
    minSharpe: '',
    requireHistory: true,
    requireHoldings: false,
    requireFeeDiscount: false,
    hideForeign: false,
  })
  const [sort, setSort] = useState({ key: 'annualized', direction: 'desc' })

  useEffect(() => {
    fetch(DATA_URL)
      .then((response) => {
        if (!response.ok) throw new Error('无法读取 public/data/funds.json，请先运行 npm run update-data')
        return response.json()
      })
      .then(setData)
      .catch((error) => setLoadError(error.message))
  }, [])

  useEffect(() => {
    if (!selectedFund) return undefined

    const bodyOverflow = document.body.style.overflow
    const htmlOverflow = document.documentElement.style.overflow

    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = bodyOverflow
      document.documentElement.style.overflow = htmlOverflow
    }
  }, [selectedFund])

  const filterOptions = useMemo(() => {
    const funds = data?.funds || []
    return {
      type: uniqueOptions(funds, 'typeLabel'),
      currency: uniqueOptions(funds, 'currency'),
      assetClass: uniqueOptions(funds, 'assetClass'),
      sector: uniqueOptions(funds, 'sector'),
    }
  }, [data])

  const filteredFunds = useMemo(() => {
    if (!data) return []
    const normalizedQuery = query.trim().toLowerCase()
    const direction = sort.direction === 'desc' ? -1 : 1

    return data.funds
      .filter((fund) => {
        const metric = metricFor(fund, viewMode, periodKey)
        const recoveryDays = metric?.drawdown?.recoveryDays ?? metric?.drawdown?.unrecoveredDays
        const drawdownAbs = Number.isFinite(metric?.maxDrawdown) ? Math.abs(metric.maxDrawdown) * 100 : null
        const annualized = Number.isFinite(metric?.annualizedReturn) ? metric.annualizedReturn * 100 : null
        const holdingText = holdingSearchText(fund)

        if (filters.requireHistory && fund.localMetrics.pointCount < 2) return false
        if (
          filters.requireHoldings &&
          !fund.holdingProfile?.topHoldings?.length &&
          !fund.holdingProfile?.fundHoldings?.length
        ) return false
        if (filters.requireFeeDiscount && !fund.purchaseFee?.hasCurrentDiscount) return false
        if (filters.hideForeign && isForeignCurrency(fund)) return false
        if (filters.type !== 'all' && fund.typeLabel !== filters.type) return false
        if (filters.currency !== 'all' && fund.currency !== filters.currency) return false
        if (filters.assetClass !== 'all' && fund.assetClass !== filters.assetClass) return false
        if (filters.sector !== 'all' && fund.sector !== filters.sector) return false
        if (filters.minAnnualized && (!Number.isFinite(annualized) || annualized < Number(filters.minAnnualized))) return false
        if (filters.maxDrawdown && (!Number.isFinite(drawdownAbs) || drawdownAbs > Number(filters.maxDrawdown))) return false
        if (filters.maxRecoveryDays && (!Number.isFinite(recoveryDays) || recoveryDays > Number(filters.maxRecoveryDays))) return false
        if (filters.minSharpe && (!Number.isFinite(metric?.sharpe) || metric.sharpe < Number(filters.minSharpe))) return false

        if (normalizedQuery) {
          const haystack =
            `${fund.name} ${fund.isin} ${fund.house} ${fund.sector} ${fund.assetClass} ${holdingText} ${fund.purchaseFee?.discountTitle || ''}`.toLowerCase()
          const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
          if (!tokens.every((token) => haystack.includes(token))) return false
        }

        return true
      })
      .sort((a, b) => {
        const result = compareValues(getSortValue(a, sort.key, viewMode, periodKey), getSortValue(b, sort.key, viewMode, periodKey), direction)
        if (result !== 0) return result
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
  }, [data, filters, periodKey, query, sort, viewMode])

  const setFilter = (key, value) => {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  const handleSort = (key) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }))
  }

  if (loadError) {
    return (
      <main className="error-state">
        <AlertTriangle size={28} />
        <h1>数据还没准备好</h1>
        <p>{loadError}</p>
      </main>
    )
  }

  if (!data) {
    return (
      <main className="loading-state">
        <RefreshCw className="spin" size={28} />
        <p>加载基金数据...</p>
      </main>
    )
  }

  return (
    <main className={`app-shell color-${colorMode}`}>
      <SummaryPanel
        data={data}
      />

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-primary">
            <div className="segmented page-tabs">
              <button className={activeTab === 'funds' ? 'active' : ''} type="button" onClick={() => setActiveTab('funds')}>
                基金筛选
              </button>
              <button className={activeTab === 'portfolio' ? 'active' : ''} type="button" onClick={() => setActiveTab('portfolio')}>
                组合回测
              </button>
            </div>
            {activeTab === 'funds' ? (
              <div className="search-box">
                <Search size={17} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索基金、ISIN、基金公司、持仓、地区、行业"
                />
              </div>
            ) : (
              <div className="tab-title">
                <PieChart size={18} />
                <span>自定义基金组合、买入日期和历史收益</span>
              </div>
            )}
          </div>
          <div className="topbar-actions">
            {activeTab === 'funds' ? (
              <div className="segmented">
                <button className={viewMode === 'cny' ? 'active' : ''} type="button" onClick={() => setViewMode('cny')}>
                  人民币视角
                </button>
                <button className={viewMode === 'local' ? 'active' : ''} type="button" onClick={() => setViewMode('local')}>
                  原币视角
                </button>
              </div>
            ) : null}
            <div className="segmented">
              <button
                className={colorMode === 'a-share' ? 'active' : ''}
                type="button"
                onClick={() => setColorMode('a-share')}
              >
                红涨绿跌
              </button>
              <button
                className={colorMode === 'global' ? 'active' : ''}
                type="button"
                onClick={() => setColorMode('global')}
              >
                绿涨红跌
              </button>
            </div>
            <a className="source-link" href="https://www.sc.com/cn/investment/funds/" target="_blank" rel="noreferrer">
              渣打原页
              <ExternalLink size={14} />
            </a>
          </div>
        </header>

        {activeTab === 'portfolio' ? (
          <PortfolioBuilder data={data} onOpenFund={setSelectedFund} />
        ) : (
          <>
            <section className="filters">
              <SelectControl
                icon={LineChart}
                label="观察区间"
                value={periodKey}
                onChange={setPeriodKey}
                options={PERIODS.map((period) => ({ value: period.key, label: period.label }))}
              />
              <SelectControl
                icon={Filter}
                label="类型"
                value={filters.type}
                onChange={(value) => setFilter('type', value)}
                options={[{ value: 'all', label: '全部类型' }, ...filterOptions.type.map((value) => ({ value, label: value }))]}
              />
              <SelectControl
                label="币种"
                value={filters.currency}
                onChange={(value) => setFilter('currency', value)}
                options={[{ value: 'all', label: '全部币种' }, ...filterOptions.currency.map((value) => ({ value, label: value }))]}
              />
              <SelectControl
                label="资产"
                value={filters.assetClass}
                onChange={(value) => setFilter('assetClass', value)}
                options={[{ value: 'all', label: '全部资产' }, ...filterOptions.assetClass.map((value) => ({ value, label: value }))]}
              />
              <SelectControl
                label="细分"
                value={filters.sector}
                onChange={(value) => setFilter('sector', value)}
                options={[{ value: 'all', label: '全部细分' }, ...filterOptions.sector.map((value) => ({ value, label: value }))]}
              />
              <NumberControl
                label="最低年化"
                value={filters.minAnnualized}
                onChange={(value) => setFilter('minAnnualized', value)}
                min="-100"
                max="300"
                suffix="%"
              />
              <NumberControl
                label="最大回撤"
                value={filters.maxDrawdown}
                onChange={(value) => setFilter('maxDrawdown', value)}
                min="0"
                max="100"
                suffix="%"
              />
              <NumberControl
                label="修复天数"
                value={filters.maxRecoveryDays}
                onChange={(value) => setFilter('maxRecoveryDays', value)}
                min="0"
                max="2000"
                suffix="天"
              />
              <NumberControl
                label="最低夏普"
                value={filters.minSharpe}
                onChange={(value) => setFilter('minSharpe', value)}
                min="-5"
                max="10"
                step="0.1"
              />
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={filters.requireHistory}
                  onChange={(event) => setFilter('requireHistory', event.target.checked)}
                />
                <span>只看有历史曲线</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={filters.requireHoldings}
                  onChange={(event) => setFilter('requireHoldings', event.target.checked)}
                />
                <span>只看有持仓</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={filters.requireFeeDiscount}
                  onChange={(event) => setFilter('requireFeeDiscount', event.target.checked)}
                />
                <span>只看费率折扣</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={filters.hideForeign}
                  onChange={(event) => setFilter('hideForeign', event.target.checked)}
                />
                <span>隐藏外币</span>
              </label>
            </section>

            <div className="result-head">
              <div>
                <h2>{filteredFunds.length} 只匹配</h2>
                <p>
                  当前按 {PERIOD_LABELS[periodKey]} / {viewMode === 'cny' ? '人民币视角' : '原币视角'} 排序筛选。
                </p>
              </div>
              <div className="legend">
                <span><Info size={14} />最大回撤为负数，越接近 0 越稳</span>
                <span><AlertTriangle size={14} />外币已计入汇率波动</span>
                <span>{colorMode === 'a-share' ? '红涨绿跌' : '绿涨红跌'}</span>
              </div>
            </div>

            <FundTable
              funds={filteredFunds}
              viewMode={viewMode}
              periodKey={periodKey}
              sort={sort}
              onSort={handleSort}
              onOpenFund={setSelectedFund}
            />
          </>
        )}
      </section>

      {selectedFund && (
        <FundDrawer fund={selectedFund} onClose={() => setSelectedFund(null)} />
      )}
    </main>
  )
}

export default App
