export const PERIODS = [
  { key: '1m', label: '近1月', amount: 1, unit: 'month', minDays: 14 },
  { key: '3m', label: '近3月', amount: 3, unit: 'month', minDays: 60 },
  { key: '6m', label: '近6月', amount: 6, unit: 'month', minDays: 120 },
  { key: '1y', label: '近1年', amount: 1, unit: 'year', minDays: 240 },
  { key: '3y', label: '近3年', amount: 3, unit: 'year', minDays: 720 },
  { key: '5y', label: '近5年', amount: 5, unit: 'year', minDays: 1200 },
]

export const FEE_RATE = 0.03
export const RISK_FREE_RATE = 0.02

const DAY_MS = 24 * 60 * 60 * 1000

export function toDate(value) {
  return new Date(`${value}T00:00:00Z`)
}

export function daysBetween(start, end) {
  if (!start || !end) return null
  return Math.max(0, Math.round((toDate(end).getTime() - toDate(start).getTime()) / DAY_MS))
}

export function shiftDate(dateString, amount, unit) {
  const date = toDate(dateString)
  if (unit === 'year') {
    date.setUTCFullYear(date.getUTCFullYear() - amount)
  } else {
    date.setUTCMonth(date.getUTCMonth() - amount)
  }
  return date.toISOString().slice(0, 10)
}

export function formatPercent(value, digits = 2) {
  if (!Number.isFinite(value)) return '-'
  return `${(value * 100).toFixed(digits)}%`
}

export function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return '-'
  return value.toFixed(digits)
}

export function formatDays(value) {
  if (!Number.isFinite(value)) return '-'
  return `${Math.round(value)}天`
}

export function normalizeHistory(history = []) {
  const seen = new Set()
  return history
    .map((point) => ({
      date: point.date,
      value: Number(point.value),
    }))
    .filter((point) => {
      if (!point.date || !Number.isFinite(point.value) || point.value <= 0 || seen.has(point.date)) {
        return false
      }
      seen.add(point.date)
      return true
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

export function sliceHistory(history, periodKey) {
  const points = normalizeHistory(history)
  if (points.length < 2) return []

  const period = PERIODS.find((item) => item.key === periodKey)
  if (!period) return points

  const endDate = points.at(-1).date
  const startDate = shiftDate(endDate, period.amount, period.unit)
  return points.filter((point) => point.date >= startDate)
}

function standardDeviation(values) {
  if (values.length < 2) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export function computeMaxDrawdown(points) {
  if (!points || points.length < 2) return null

  let peakValue = points[0].value
  let peakDate = points[0].date
  let maxDrawdown = 0
  let maxPeakValue = peakValue
  let maxPeakDate = peakDate
  let troughValue = peakValue
  let troughDate = peakDate

  for (const point of points) {
    if (point.value > peakValue) {
      peakValue = point.value
      peakDate = point.date
    }

    const drawdown = point.value / peakValue - 1
    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown
      maxPeakValue = peakValue
      maxPeakDate = peakDate
      troughValue = point.value
      troughDate = point.date
    }
  }

  let recoveryDate = null
  const troughIndex = points.findIndex((point) => point.date === troughDate)
  for (let index = troughIndex + 1; index < points.length; index += 1) {
    if (points[index].value >= maxPeakValue) {
      recoveryDate = points[index].date
      break
    }
  }

  return {
    maxDrawdown,
    peakDate: maxPeakDate,
    peakValue: maxPeakValue,
    troughDate,
    troughValue,
    recoveryDate,
    recovered: Boolean(recoveryDate),
    recoveryDays: recoveryDate ? daysBetween(troughDate, recoveryDate) : null,
    drawdownDurationDays: recoveryDate ? daysBetween(maxPeakDate, recoveryDate) : null,
    unrecoveredDays: recoveryDate ? null : daysBetween(troughDate, points.at(-1).date),
  }
}

export function computeIntervalMetrics(history, periodKey, feeRate = FEE_RATE) {
  const points = sliceHistory(history, periodKey)
  if (points.length < 2) return null

  const period = PERIODS.find((item) => item.key === periodKey)
  const start = points[0]
  const end = points.at(-1)
  const days = daysBetween(start.date, end.date)
  if (!days) return null
  if (period?.minDays && days < period.minDays) return null

  const totalReturn = end.value / start.value - 1
  const annualizedReturn = (end.value / start.value) ** (365 / days) - 1
  const returns = []

  for (let index = 1; index < points.length; index += 1) {
    returns.push(points[index].value / points[index - 1].value - 1)
  }

  const dailyVolatility = standardDeviation(returns)
  const annualizedVolatility = Number.isFinite(dailyVolatility) ? dailyVolatility * Math.sqrt(252) : null
  const sharpe =
    Number.isFinite(annualizedVolatility) && annualizedVolatility > 0
      ? (annualizedReturn - RISK_FREE_RATE) / annualizedVolatility
      : null

  const hasFeeRate = Number.isFinite(feeRate)
  const breakEvenValue = hasFeeRate ? start.value * (1 + feeRate) : null
  const breakEvenPoint = hasFeeRate ? points.find((point) => point.value >= breakEvenValue) : null
  const drawdown = computeMaxDrawdown(points)

  return {
    periodKey,
    startDate: start.date,
    endDate: end.date,
    startValue: start.value,
    endValue: end.value,
    days,
    points: points.length,
    totalReturn,
    annualizedReturn,
    annualizedVolatility,
    sharpe,
    maxDrawdown: drawdown?.maxDrawdown ?? null,
    drawdown,
    feeBreakEvenDays: breakEvenPoint ? daysBetween(start.date, breakEvenPoint.date) : null,
    feeBreakEvenDate: breakEvenPoint?.date ?? null,
  }
}

export function computeRollingFeeRecovery(history, feeRate = FEE_RATE, sampleStep = 5) {
  const points = normalizeHistory(history)
  if (points.length < 2) return null

  const recoveries = []
  let sampled = 0

  for (let startIndex = 0; startIndex < points.length - 1; startIndex += sampleStep) {
    sampled += 1
    const target = points[startIndex].value * (1 + feeRate)
    let recovered = null

    for (let index = startIndex + 1; index < points.length; index += 1) {
      if (points[index].value >= target) {
        recovered = daysBetween(points[startIndex].date, points[index].date)
        break
      }
    }

    if (Number.isFinite(recovered)) recoveries.push(recovered)
  }

  if (!sampled) return null
  const sorted = [...recoveries].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
  const average = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null

  return {
    sampleCount: sampled,
    successCount: recoveries.length,
    successRate: recoveries.length / sampled,
    medianDays: median,
    averageDays: average,
  }
}

export function computeFundMetrics(history, feeRate = FEE_RATE) {
  const normalized = normalizeHistory(history)
  const intervals = {}

  for (const period of PERIODS) {
    intervals[period.key] = computeIntervalMetrics(normalized, period.key, feeRate)
  }

  return {
    intervals,
    rollingFeeRecovery: Number.isFinite(feeRate) ? computeRollingFeeRecovery(normalized, feeRate) : null,
    firstDate: normalized[0]?.date ?? null,
    lastDate: normalized.at(-1)?.date ?? null,
    pointCount: normalized.length,
  }
}

export function classifyType(type) {
  if (type === 'qdmf') return '代客境外理财'
  if (type === 'cmf') return '境内公募基金'
  return type || '未分类'
}
