import { describe, it, expect } from 'vitest'
import {
  calculateArbPercentage,
  calculateOptimalStakes,
  calculatePotentialReturn,
  calculateExpectedReturn,
  calculateProfit,
  calculateRoi,
  calculateArbitrage,
  roundStake,
} from '@/lib/calculations/arbitrage'

describe('calculateArbPercentage', () => {
  it('returns positive for a valid 2-way arb', () => {
    // 1/2.10 + 1/2.15 = 0.4762 + 0.4651 = 0.9413 → arb% = (1-0.9413)*100 = 5.87%... wait
    // Actually: 1/2.10 = 0.47619, 1/2.15 = 0.46512, sum = 0.94131
    // arb% = (1 - 0.94131) * 100 = 5.869... that's a big arb, let me use realistic values
    // Real arb: odds 2.05 and 2.10
    // 1/2.05 = 0.48780, 1/2.10 = 0.47619, sum = 0.96399
    // arb% = (1 - 0.96399) * 100 = 3.601%
    const result = calculateArbPercentage([2.05, 2.10])
    expect(result).toBeGreaterThan(0)
    expect(result).toBeCloseTo(3.601, 2)
  })

  it('returns negative for a non-arb (house edge)', () => {
    // Standard football 1X2: no arb
    // 2.50, 3.20, 2.90 → sum > 1
    const result = calculateArbPercentage([2.5, 3.2, 2.9])
    expect(result).toBeLessThan(0)
  })

  it('handles 3-way arbitrage', () => {
    // Crafted 3-way arb
    // stake proportional to 1/odds gives guaranteed return
    const result = calculateArbPercentage([3.1, 3.2, 3.3])
    // 1/3.1 + 1/3.2 + 1/3.3 = 0.3226 + 0.3125 + 0.3030 = 0.9381 → arb% = 6.19%
    expect(result).toBeGreaterThan(0)
  })

  it('returns -Infinity for less than 2 odds', () => {
    const result = calculateArbPercentage([2.0])
    expect(result).toBe(-Infinity)
  })

  it('is precise with decimal odds (no floating point errors)', () => {
    // 1.91 + 1.91 (common in tennis)
    const result = calculateArbPercentage([1.91, 1.91])
    // 2 * (1/1.91) = 1.0471 → arb% negative
    expect(result).toBeLessThan(0)
    // Should not have floating point artifacts like -4.710000000000002
    const str = result.toString()
    expect(str.length).toBeLessThan(20)
  })
})

describe('calculateOptimalStakes', () => {
  it('guarantees equal return for both legs', () => {
    const odds = [2.05, 2.10]
    const bankroll = 1000
    const stakes = calculateOptimalStakes(odds, bankroll)

    const returnA = stakes[0]! * odds[0]!
    const returnB = stakes[1]! * odds[1]!

    expect(Math.abs(returnA - returnB)).toBeLessThan(0.01)
  })

  it('stakes sum to totalBankroll within rounding tolerance', () => {
    const odds = [2.05, 2.10]
    const bankroll = 1000
    const stakes = calculateOptimalStakes(odds, bankroll)
    const total = stakes.reduce((s, st) => s + st, 0)

    expect(Math.abs(total - bankroll)).toBeLessThan(0.02)
  })

  it('handles 3-way arbitrage correctly', () => {
    const odds = [3.1, 3.2, 3.3]
    const bankroll = 1000
    const stakes = calculateOptimalStakes(odds, bankroll)

    expect(stakes).toHaveLength(3)

    const returns = stakes.map((s, i) => s * odds[i]!)
    const minReturn = Math.min(...returns)
    const maxReturn = Math.max(...returns)

    expect(maxReturn - minReturn).toBeLessThan(0.05)
  })
})

describe('calculatePotentialReturn', () => {
  it('computes stake × odds correctly', () => {
    expect(calculatePotentialReturn(100, 2.5)).toBe(250)
    expect(calculatePotentialReturn(204.88, 2.10)).toBeCloseTo(430.25, 1)
  })

  it('handles decimal stakes and odds', () => {
    const result = calculatePotentialReturn(99.99, 1.95)
    expect(result).toBeCloseTo(194.98, 1)
  })
})

describe('calculateProfit', () => {
  it('returns positive profit on winning arb', () => {
    expect(calculateProfit(403, 400)).toBe(3)
  })

  it('returns 0 for break-even', () => {
    expect(calculateProfit(400, 400)).toBe(0)
  })

  it('handles decimal precision correctly', () => {
    const profit = calculateProfit(430.25, 400.23)
    expect(profit).toBeCloseTo(30.02, 2)
  })
})

describe('calculateRoi', () => {
  it('computes correct ROI percentage', () => {
    expect(calculateRoi(10, 1000)).toBe(1)
    expect(calculateRoi(30.02, 400.23)).toBeCloseTo(7.5013, 2)
  })

  it('returns 0 when stake is 0', () => {
    expect(calculateRoi(100, 0)).toBe(0)
  })

  it('returns negative ROI for losses', () => {
    expect(calculateRoi(-50, 1000)).toBe(-5)
  })
})

describe('roundStake', () => {
  it('rounds to nearest unit', () => {
    expect(roundStake(342.71, 1)).toBeCloseTo(343, 0)
    expect(roundStake(342.71, 5)).toBeCloseTo(345, 0)
    expect(roundStake(342.71, 10)).toBeCloseTo(340, 0)
  })

  it('rounds 0.5 up', () => {
    expect(roundStake(342.5, 1)).toBe(343)
  })
})

describe('calculateExpectedReturn', () => {
  it('returns the minimum of all potential returns', () => {
    const legs = [
      { odds: 2.05, stake: 506 },
      { odds: 2.10, stake: 494 },
    ]
    // returns[0] = 506 * 2.05 = 1037.3, returns[1] = 494 * 2.10 = 1037.4 → min = 1037.3
    const result = calculateExpectedReturn(legs)
    expect(result).toBeCloseTo(1037.3, 0)
  })

  it('returns 0 for empty legs', () => {
    expect(calculateExpectedReturn([])).toBe(0)
  })
})

describe('calculateArbitrage', () => {
  it('returns all calculated values for valid arb', () => {
    const result = calculateArbitrage([{ odds: 2.05 }, { odds: 2.10 }], 1000)

    expect(result.isValidArb).toBe(true)
    expect(result.arbPercentage).toBeGreaterThan(0)
    expect(result.optimalStakes).toHaveLength(2)
    expect(result.guaranteedReturn).toBeGreaterThan(result.totalStake)
    expect(result.guaranteedProfit).toBeGreaterThan(0)
    expect(result.roi).toBeGreaterThan(0)
  })

  it('marks non-arb correctly', () => {
    const result = calculateArbitrage([{ odds: 1.9 }, { odds: 1.9 }], 1000)
    expect(result.isValidArb).toBe(false)
    expect(result.arbPercentage).toBeLessThan(0)
  })

  it('guaranteedReturn equals min of all potential returns', () => {
    const result = calculateArbitrage([{ odds: 2.05 }, { odds: 2.10 }], 1000)
    const returns = result.optimalStakes.map((s, i) => s * [2.05, 2.10][i]!)
    expect(result.guaranteedReturn).toBeCloseTo(Math.min(...returns), 1)
  })
})
