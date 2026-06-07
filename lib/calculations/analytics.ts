import Decimal from 'decimal.js'

export interface DailyValue {
  date: string
  value: number
}

export interface TimeSeriesPoint {
  date: string
  value: number
  cumulative: number
}

export interface StreakResult {
  currentWinStreak: number
  currentLossStreak: number
  maxWinStreak: number
  maxLossStreak: number
}

/**
 * Yield = profit / turnover × 100.
 * En arbitraje puro equivale al ROI, pero es la métrica estándar en betting analytics.
 */
export function calculateYield(totalProfit: number, totalTurnover: number): number {
  if (totalTurnover === 0) return 0
  return new Decimal(totalProfit).div(new Decimal(totalTurnover)).mul(100).toDecimalPlaces(4).toNumber()
}

/**
 * Maximum Drawdown: mayor caída desde el pico en la serie de profit acumulado.
 * Algoritmo O(n): una sola pasada.
 */
export function calculateMaxDrawdown(cumulativeProfitSeries: number[]): number {
  if (cumulativeProfitSeries.length === 0) return 0

  let peak = cumulativeProfitSeries[0] ?? 0
  let maxDrawdown = 0

  for (const value of cumulativeProfitSeries) {
    if (value > peak) peak = value
    const drawdown = peak - value
    if (drawdown > maxDrawdown) maxDrawdown = drawdown
  }

  return new Decimal(maxDrawdown).toDecimalPlaces(2).toNumber()
}

/**
 * ROI anualizado.
 * Fórmula: ((1 + roi/100) ^ (365/activeDays) - 1) × 100
 */
export function calculateAnnualizedRoi(cumulativeRoi: number, activeDays: number): number {
  if (activeDays <= 0) return 0

  const base = new Decimal(1).plus(new Decimal(cumulativeRoi).div(100))
  const exponent = new Decimal(365).div(new Decimal(activeDays))

  try {
    return base.pow(exponent).minus(1).mul(100).toDecimalPlaces(4).toNumber()
  } catch {
    return cumulativeRoi
  }
}

/**
 * Beneficio medio por operación.
 */
export function calculateAvgProfitPerArbitrage(
  totalProfit: number,
  operationCount: number,
): number {
  if (operationCount === 0) return 0
  return new Decimal(totalProfit).div(new Decimal(operationCount)).toDecimalPlaces(2).toNumber()
}

/**
 * Construye la serie acumulada desde valores diarios.
 */
export function buildCumulativeSeries(dailyValues: DailyValue[]): TimeSeriesPoint[] {
  let cumulative = new Decimal(0)

  return dailyValues.map(({ date, value }) => {
    cumulative = cumulative.plus(new Decimal(value))
    return {
      date,
      value: new Decimal(value).toDecimalPlaces(2).toNumber(),
      cumulative: cumulative.toDecimalPlaces(2).toNumber(),
    }
  })
}

/**
 * Calcula rachas consecutivas de ganancia/pérdida.
 */
export function calculateStreaks(grossProfits: number[]): StreakResult {
  if (grossProfits.length === 0) {
    return { currentWinStreak: 0, currentLossStreak: 0, maxWinStreak: 0, maxLossStreak: 0 }
  }

  let maxWinStreak = 0
  let maxLossStreak = 0
  let currentWin = 0
  let currentLoss = 0

  for (const profit of grossProfits) {
    if (profit > 0) {
      currentWin++
      currentLoss = 0
      if (currentWin > maxWinStreak) maxWinStreak = currentWin
    } else if (profit < 0) {
      currentLoss++
      currentWin = 0
      if (currentLoss > maxLossStreak) maxLossStreak = currentLoss
    } else {
      // break-even: resets both streaks
      currentWin = 0
      currentLoss = 0
    }
  }

  return { currentWinStreak: currentWin, currentLossStreak: currentLoss, maxWinStreak, maxLossStreak }
}

/**
 * Agrupa una lista de {date, value} por período.
 */
export function groupByPeriod(
  items: { date: Date; value: number }[],
  groupBy: 'day' | 'week' | 'month' | 'year',
): { period: string; value: number; count: number }[] {
  const map = new Map<string, { value: Decimal; count: number }>()

  for (const item of items) {
    const key = getPeriodKey(item.date, groupBy)
    const existing = map.get(key) ?? { value: new Decimal(0), count: 0 }
    map.set(key, {
      value: existing.value.plus(new Decimal(item.value)),
      count: existing.count + 1,
    })
  }

  return Array.from(map.entries())
    .map(([period, { value, count }]) => ({
      period,
      value: value.toDecimalPlaces(2).toNumber(),
      count,
    }))
    .sort((a, b) => a.period.localeCompare(b.period))
}

function getPeriodKey(date: Date, groupBy: 'day' | 'week' | 'month' | 'year'): string {
  const d = new Date(date)
  switch (groupBy) {
    case 'day':
      return d.toISOString().slice(0, 10)
    case 'week': {
      const startOfWeek = new Date(d)
      startOfWeek.setDate(d.getDate() - d.getDay())
      return startOfWeek.toISOString().slice(0, 10)
    }
    case 'month':
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    case 'year':
      return String(d.getFullYear())
  }
}
