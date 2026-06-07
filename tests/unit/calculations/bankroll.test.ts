import { describe, it, expect } from 'vitest'
import {
  reconstructBalance,
  verifyBalanceIntegrity,
  calculateAvailableBalance,
  calculateTotalBankroll,
  calculateBookmakerRoi,
  calculateInitialCapital,
} from '@/lib/calculations/bankroll'

const makeDate = (offset: number) => new Date(Date.now() + offset * 1000)

describe('reconstructBalance', () => {
  it('correctly replays a sequence of transactions', () => {
    const transactions = [
      { type: 'INITIAL_DEPOSIT', amount: 1000, balanceAfter: 1000, createdAt: makeDate(0) },
      { type: 'DEPOSIT', amount: 500, balanceAfter: 1500, createdAt: makeDate(1) },
      { type: 'BET_PLACED', amount: -200, balanceAfter: 1300, createdAt: makeDate(2) },
      { type: 'BET_RETURN', amount: 420, balanceAfter: 1720, createdAt: makeDate(3) },
      { type: 'WITHDRAWAL', amount: -500, balanceAfter: 1220, createdAt: makeDate(4) },
    ]

    const result = reconstructBalance(transactions)
    expect(result).toBeCloseTo(1220, 2)
  })

  it('handles empty transactions', () => {
    expect(reconstructBalance([])).toBe(0)
  })

  it('sorts by createdAt before replaying', () => {
    const transactions = [
      { type: 'BET_PLACED', amount: -200, balanceAfter: 800, createdAt: makeDate(2) },
      { type: 'INITIAL_DEPOSIT', amount: 1000, balanceAfter: 1000, createdAt: makeDate(0) },
    ]

    const result = reconstructBalance(transactions)
    expect(result).toBeCloseTo(800, 2)
  })

  it('handles decimal precision without floating point errors', () => {
    const transactions = [
      { type: 'INITIAL_DEPOSIT', amount: 1000.00, balanceAfter: 1000, createdAt: makeDate(0) },
      { type: 'BET_PLACED', amount: -195.35, balanceAfter: 804.65, createdAt: makeDate(1) },
      { type: 'BET_PLACED', amount: -204.88, balanceAfter: 599.77, createdAt: makeDate(2) },
      { type: 'BET_RETURN', amount: 430.25, balanceAfter: 1030.02, createdAt: makeDate(3) },
    ]

    const result = reconstructBalance(transactions)
    expect(result).toBeCloseTo(1030.02, 2)
  })
})

describe('verifyBalanceIntegrity', () => {
  it('returns consistent true when balance matches', () => {
    const txs = [
      { type: 'INITIAL_DEPOSIT', amount: 1000, balanceAfter: 1000, createdAt: makeDate(0) },
    ]
    const { isConsistent, calculated } = verifyBalanceIntegrity(txs, 1000)
    expect(isConsistent).toBe(true)
    expect(calculated).toBe(1000)
  })

  it('detects discrepancy', () => {
    const txs = [
      { type: 'INITIAL_DEPOSIT', amount: 1000, balanceAfter: 1000, createdAt: makeDate(0) },
    ]
    const { isConsistent, difference } = verifyBalanceIntegrity(txs, 999)
    expect(isConsistent).toBe(false)
    expect(difference).toBeCloseTo(1, 2)
  })
})

describe('calculateAvailableBalance', () => {
  it('subtracts pending stakes from current balance', () => {
    expect(calculateAvailableBalance(1000, 200)).toBe(800)
  })

  it('never returns negative', () => {
    expect(calculateAvailableBalance(100, 500)).toBe(0)
  })

  it('handles zero pending stakes', () => {
    expect(calculateAvailableBalance(1500, 0)).toBe(1500)
  })
})

describe('calculateTotalBankroll', () => {
  const bookmakers = [
    { id: '1', currentBalance: 1000, currency: 'EUR', pendingStakes: 200 },
    { id: '2', currentBalance: 500, currency: 'EUR', pendingStakes: 0 },
    { id: '3', currentBalance: 800, currency: 'GBP', pendingStakes: 0 },
  ]

  it('sums only bookmakers with primaryCurrency', () => {
    const totals = calculateTotalBankroll(bookmakers, 'EUR')
    expect(totals.effective).toBe(1500)
  })

  it('excludes bookmakers with different currency', () => {
    const totals = calculateTotalBankroll(bookmakers, 'EUR')
    expect(totals.effective).not.toContain(800)
  })

  it('correctly calculates inPlay', () => {
    const totals = calculateTotalBankroll(bookmakers, 'EUR')
    expect(totals.inPlay).toBe(200)
  })

  it('available = effective - inPlay', () => {
    const totals = calculateTotalBankroll(bookmakers, 'EUR')
    expect(totals.available).toBe(1300)
  })
})

describe('calculateBookmakerRoi', () => {
  it('calculates correct ROI', () => {
    expect(calculateBookmakerRoi(100, 1000)).toBe(10)
  })

  it('returns 0 when staked is 0', () => {
    expect(calculateBookmakerRoi(100, 0)).toBe(0)
  })

  it('handles negative profit', () => {
    expect(calculateBookmakerRoi(-50, 1000)).toBe(-5)
  })
})

describe('calculateInitialCapital', () => {
  it('sums deposits and bonuses, subtracts withdrawals', () => {
    const txs = [
      { type: 'INITIAL_DEPOSIT', amount: 1000, balanceAfter: 1000, createdAt: makeDate(0) },
      { type: 'DEPOSIT', amount: 500, balanceAfter: 1500, createdAt: makeDate(1) },
      { type: 'BONUS', amount: 50, balanceAfter: 1550, createdAt: makeDate(2) },
      { type: 'WITHDRAWAL', amount: -200, balanceAfter: 1350, createdAt: makeDate(3) },
      { type: 'BET_PLACED', amount: -300, balanceAfter: 1050, createdAt: makeDate(4) }, // excluded
      { type: 'BET_RETURN', amount: 630, balanceAfter: 1680, createdAt: makeDate(5) }, // excluded
    ]

    const capital = calculateInitialCapital(txs)
    expect(capital).toBe(1350) // 1000 + 500 + 50 - 200
  })
})
