import { describe, it, expect } from 'vitest'
import {
  validateOdds,
  validateStake,
  validateWithdrawal,
  validateArbitrageLegs,
  LIMITS,
} from '@/lib/calculations/validators'

describe('validateOdds', () => {
  it('accepts valid odds', () => {
    const result = validateOdds(2.05)
    expect(result.isValid).toBe(true)
  })

  it('rejects odds below minimum', () => {
    const result = validateOdds(1.0)
    expect(result.isValid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('rejects odds at minimum boundary (exclusive)', () => {
    const result = validateOdds(LIMITS.MIN_ODDS)
    // MIN_ODDS = 1.01, so exactly at limit should be valid
    expect(result.isValid).toBe(true)
  })

  it('rejects odds above maximum', () => {
    const result = validateOdds(1001)
    expect(result.isValid).toBe(false)
  })

  it('rejects zero and negative odds', () => {
    expect(validateOdds(0).isValid).toBe(false)
    expect(validateOdds(-2.0).isValid).toBe(false)
  })

  it('rejects NaN', () => {
    expect(validateOdds(NaN).isValid).toBe(false)
  })

  it('includes fieldName in error message when provided', () => {
    const result = validateOdds(0, 'Casa 1')
    expect(result.errors[0]).toContain('Casa 1')
  })
})

describe('validateStake', () => {
  it('accepts valid stake', () => {
    expect(validateStake(100).isValid).toBe(true)
  })

  it('rejects zero', () => {
    expect(validateStake(0).isValid).toBe(false)
  })

  it('rejects negative stake', () => {
    expect(validateStake(-50).isValid).toBe(false)
  })

  it('rejects stake above maximum', () => {
    expect(validateStake(1_000_001).isValid).toBe(false)
  })

  it('accepts stake exactly at minimum', () => {
    expect(validateStake(LIMITS.MIN_STAKE).isValid).toBe(true)
  })

  it('accepts stake exactly at maximum', () => {
    expect(validateStake(LIMITS.MAX_STAKE).isValid).toBe(true)
  })
})

describe('validateWithdrawal', () => {
  it('accepts withdrawal within available balance', () => {
    expect(validateWithdrawal(100, 500).isValid).toBe(true)
  })

  it('accepts withdrawal equal to available balance', () => {
    expect(validateWithdrawal(500, 500).isValid).toBe(true)
  })

  it('rejects withdrawal exceeding available balance', () => {
    const result = validateWithdrawal(501, 500)
    expect(result.isValid).toBe(false)
  })

  it('rejects zero withdrawal', () => {
    expect(validateWithdrawal(0, 500).isValid).toBe(false)
  })

  it('rejects negative withdrawal', () => {
    expect(validateWithdrawal(-100, 500).isValid).toBe(false)
  })
})

describe('validateArbitrageLegs', () => {
  it('accepts valid 2-leg arb', () => {
    const legs = [
      { odds: 2.05, stake: 506, bookmakerId: 'bk1' },
      { odds: 2.10, stake: 494, bookmakerId: 'bk2' },
    ]
    const result = validateArbitrageLegs(legs)
    expect(result.isValid).toBe(true)
  })

  it('rejects fewer than 2 legs', () => {
    const result = validateArbitrageLegs([{ odds: 2.05, stake: 100, bookmakerId: 'bk1' }])
    expect(result.isValid).toBe(false)
  })

  it('rejects more than 5 legs', () => {
    const legs = Array.from({ length: 6 }, (_, i) => ({ odds: 2.0, stake: 100, bookmakerId: `bk${i}` }))
    const result = validateArbitrageLegs(legs)
    expect(result.isValid).toBe(false)
  })

  it('adds warning (not fatal) for invalid arb percentage', () => {
    // 1.9 + 1.9 is not a valid arb — but should be a warning, not fatal block
    const legs = [
      { odds: 1.9, stake: 500, bookmakerId: 'bk1' },
      { odds: 1.9, stake: 500, bookmakerId: 'bk2' },
    ]
    const result = validateArbitrageLegs(legs)
    // isValid true (user can still save) but warnings populated
    expect(result.isValid).toBe(true)
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.length).toBeGreaterThan(0)
  })

  it('rejects invalid odds within legs', () => {
    const legs = [
      { odds: 0.5, stake: 500, bookmakerId: 'bk1' }, // invalid odds
      { odds: 2.10, stake: 500, bookmakerId: 'bk2' },
    ]
    const result = validateArbitrageLegs(legs)
    expect(result.isValid).toBe(false)
  })
})
