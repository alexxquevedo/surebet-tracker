import { calculateArbPercentage } from './arbitrage'

export const LIMITS = {
  MIN_ODDS: 1.01,
  MAX_ODDS: 1000,
  MIN_STAKE: 0.01,
  MAX_STAKE: 1_000_000,
  MIN_ARB_PCT: 0,
  MIN_LEGS: 2,
  MAX_LEGS: 5,
} as const

export interface ValidationError {
  field: string
  code: string
  message: string
}

export interface ValidationResult {
  isValid: boolean
  errors: ValidationError[]
  warnings?: ValidationError[]
}

function ok(): ValidationResult {
  return { isValid: true, errors: [] }
}

function fail(errors: ValidationError[]): ValidationResult {
  return { isValid: false, errors }
}

export function validateOdds(odds: number, fieldName = 'odds'): ValidationResult {
  if (!isFinite(odds) || isNaN(odds)) {
    return fail([{ field: fieldName, code: 'INVALID_ODDS', message: 'Las cuotas no son válidas' }])
  }
  if (odds <= 1) {
    return fail([
      { field: fieldName, code: 'INVALID_ODDS', message: 'Las cuotas deben ser mayores que 1' },
    ])
  }
  if (odds > LIMITS.MAX_ODDS) {
    return fail([
      { field: fieldName, code: 'INVALID_ODDS', message: `Las cuotas no pueden superar ${LIMITS.MAX_ODDS}` },
    ])
  }
  return ok()
}

export function validateStake(stake: number, fieldName = 'stake'): ValidationResult {
  if (!isFinite(stake) || isNaN(stake)) {
    return fail([{ field: fieldName, code: 'INVALID_STAKE', message: 'El stake no es válido' }])
  }
  if (stake < LIMITS.MIN_STAKE) {
    return fail([
      { field: fieldName, code: 'INVALID_STAKE', message: `El stake mínimo es €${LIMITS.MIN_STAKE}` },
    ])
  }
  if (stake > LIMITS.MAX_STAKE) {
    return fail([
      { field: fieldName, code: 'INVALID_STAKE', message: `El stake máximo es €${LIMITS.MAX_STAKE.toLocaleString()}` },
    ])
  }
  return ok()
}

export function validateWithdrawal(amount: number, availableBalance: number): ValidationResult {
  const stakeResult = validateStake(amount, 'amount')
  if (!stakeResult.isValid) return stakeResult

  if (amount > availableBalance) {
    return fail([
      {
        field: 'amount',
        code: 'INSUFFICIENT_BALANCE',
        message: `Balance disponible insuficiente. Disponible: €${availableBalance.toFixed(2)}`,
      },
    ])
  }
  return ok()
}

export interface LegForValidation {
  odds: number
  stake: number
  bookmakerId: string
}

/**
 * Valida todas las piernas de un arbitraje antes de persistirlo.
 */
export function validateArbitrageLegs(legs: LegForValidation[]): ValidationResult {
  const errors: ValidationError[] = []

  if (legs.length < LIMITS.MIN_LEGS) {
    errors.push({
      field: 'legs',
      code: 'MIN_LEGS_REQUIRED',
      message: `Un arbitraje necesita al menos ${LIMITS.MIN_LEGS} piernas`,
    })
    return fail(errors)
  }

  if (legs.length > LIMITS.MAX_LEGS) {
    errors.push({
      field: 'legs',
      code: 'MAX_LEGS_EXCEEDED',
      message: `Un arbitraje puede tener máximo ${LIMITS.MAX_LEGS} piernas`,
    })
    return fail(errors)
  }

  legs.forEach((leg, i) => {
    const oddsResult = validateOdds(leg.odds, `legs.${i}.odds`)
    if (!oddsResult.isValid) errors.push(...oddsResult.errors)

    const stakeResult = validateStake(leg.stake, `legs.${i}.stake`)
    if (!stakeResult.isValid) errors.push(...stakeResult.errors)

    if (!leg.bookmakerId) {
      errors.push({
        field: `legs.${i}.bookmakerId`,
        code: 'BOOKMAKER_REQUIRED',
        message: `La pierna ${i + 1} necesita una casa de apuestas`,
      })
    }
  })

  if (errors.length > 0) return fail(errors)

  // arb% bajo es un aviso (warning), no un error fatal — el usuario puede guardar igualmente
  const arbPct = calculateArbPercentage(legs.map((l) => l.odds))
  if (arbPct <= LIMITS.MIN_ARB_PCT) {
    return {
      isValid: true,
      errors: [],
      warnings: [
        {
          field: 'arbPercentage',
          code: 'INVALID_ARB_PERCENTAGE',
          message: `Este no es un arbitraje válido (arb%: ${arbPct.toFixed(4)}%). Verifica las cuotas.`,
        },
      ],
    }
  }

  return ok()
}
