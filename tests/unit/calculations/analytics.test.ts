import { describe, it, expect } from 'vitest'
import {
  calculateYield,
  calculateMaxDrawdown,
  calculateAnnualizedRoi,
  calculateAvgProfitPerArbitrage,
  calculateStreaks,
  buildCumulativeSeries,
  groupByPeriod,
} from '@/lib/calculations/analytics'

describe('calculateYield', () => {
  it('computes yield as profit / turnover × 100', () => {
    expect(calculateYield(100, 1000)).toBe(10)
  })

  it('returns 0 when turnover is 0', () => {
    expect(calculateYield(50, 0)).toBe(0)
  })

  it('returns negative yield for losses', () => {
    expect(calculateYield(-50, 1000)).toBe(-5)
  })
})

describe('calculateMaxDrawdown', () => {
  it('returns 0 for monotonically increasing series', () => {
    expect(calculateMaxDrawdown([10, 20, 30, 40])).toBe(0)
  })

  it('returns 0 for flat series', () => {
    expect(calculateMaxDrawdown([100, 100, 100])).toBe(0)
  })

  it('computes the maximum peak-to-trough decline', () => {
    // Peak at 100, trough at 60 → drawdown 40
    const result = calculateMaxDrawdown([0, 100, 80, 60, 90])
    expect(result).toBeCloseTo(40, 2)
  })

  it('handles series starting negative', () => {
    const result = calculateMaxDrawdown([-10, 50, 20])
    expect(result).toBeCloseTo(30, 2)
  })

  it('returns 0 for empty series', () => {
    expect(calculateMaxDrawdown([])).toBe(0)
  })

  it('runs in O(n) — single peak tracking', () => {
    // With 10k points, should complete without issue (not checking time, just that it runs)
    const big = Array.from({ length: 10000 }, (_, i) => Math.sin(i) * 1000)
    expect(() => calculateMaxDrawdown(big)).not.toThrow()
  })
})

describe('calculateAnnualizedRoi', () => {
  it('returns cumulative ROI when activeDays is 365', () => {
    // (1 + 0.1) ^ (365/365) - 1 = 0.1 → 10%
    expect(calculateAnnualizedRoi(10, 365)).toBeCloseTo(10, 4)
  })

  it('annualizes correctly for half a year', () => {
    // 10% over 182 days → annualized = ((1.1)^(365/182) - 1) × 100 ≈ 21.0%
    const result = calculateAnnualizedRoi(10, 182)
    expect(result).toBeGreaterThan(10)
  })

  it('returns 0 when activeDays is 0', () => {
    expect(calculateAnnualizedRoi(10, 0)).toBe(0)
  })
})

describe('calculateStreaks', () => {
  it('correctly counts current win streak', () => {
    const { currentWinStreak } = calculateStreaks([10, 20, 15])
    expect(currentWinStreak).toBe(3)
  })

  it('correctly counts current loss streak', () => {
    const { currentLossStreak } = calculateStreaks([10, -5, -3])
    expect(currentLossStreak).toBe(2)
  })

  it('correctly finds max win streak', () => {
    const { maxWinStreak } = calculateStreaks([10, 20, -5, 30, 40, 50])
    expect(maxWinStreak).toBe(3)
  })

  it('correctly finds max loss streak', () => {
    const { maxLossStreak } = calculateStreaks([-1, -2, -3, 10, -4])
    expect(maxLossStreak).toBe(3)
  })

  it('handles empty series', () => {
    const result = calculateStreaks([])
    expect(result.currentWinStreak).toBe(0)
    expect(result.currentLossStreak).toBe(0)
    expect(result.maxWinStreak).toBe(0)
    expect(result.maxLossStreak).toBe(0)
  })

  it('treats zero profit as neither win nor loss', () => {
    const { currentWinStreak, currentLossStreak } = calculateStreaks([10, 0])
    expect(currentWinStreak).toBe(0)
    expect(currentLossStreak).toBe(0)
  })
})

describe('buildCumulativeSeries', () => {
  it('correctly accumulates values', () => {
    const input = [
      { date: '2024-01-01', value: 10 },
      { date: '2024-01-02', value: 20 },
      { date: '2024-01-03', value: -5 },
    ]
    const result = buildCumulativeSeries(input)
    expect(result[0]!.cumulative).toBeCloseTo(10, 2)
    expect(result[1]!.cumulative).toBeCloseTo(30, 2)
    expect(result[2]!.cumulative).toBeCloseTo(25, 2)
  })

  it('preserves date labels', () => {
    const input = [{ date: '2024-06-01', value: 5 }]
    const result = buildCumulativeSeries(input)
    expect(result[0]!.date).toBe('2024-06-01')
  })
})

describe('calculateAvgProfitPerArbitrage', () => {
  it('divides total profit by operation count', () => {
    expect(calculateAvgProfitPerArbitrage(300, 10)).toBeCloseTo(30, 2)
  })

  it('returns 0 when count is 0', () => {
    expect(calculateAvgProfitPerArbitrage(300, 0)).toBe(0)
  })
})

describe('groupByPeriod', () => {
  const items = [
    { date: new Date('2024-01-05'), value: 10 },
    { date: new Date('2024-01-15'), value: 20 },
    { date: new Date('2024-02-01'), value: 30 },
  ]

  it('groups by month correctly', () => {
    const result = groupByPeriod(items, 'month')
    expect(result).toHaveLength(2)
    const jan = result.find((r) => r.period.includes('2024-01'))
    expect(jan?.count).toBe(2)
  })

  it('groups by day correctly', () => {
    const result = groupByPeriod(items, 'day')
    expect(result).toHaveLength(3)
  })
})
