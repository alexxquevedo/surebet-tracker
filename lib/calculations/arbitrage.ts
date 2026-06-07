import Decimal from 'decimal.js'

// Configuración global de Decimal.js
// 20 decimales de precisión interna, redondeo ROUND_HALF_UP (estándar financiero)
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP })

export interface LegInput {
  odds: number
  stake?: number
}

export interface ArbCalculationResult {
  arbPercentage: number
  isValidArb: boolean
  impliedProbabilities: number[]
  marginSum: number
  optimalStakes: number[]
  optimalStakesRounded: number[]
  totalStake: number
  guaranteedReturn: number
  guaranteedProfit: number
  roi: number
}

/**
 * Calcula el porcentaje de ventaja de un arbitraje.
 * Fórmula: (1 - sum(1/odds_i)) × 100
 * Positivo = arbitraje válido (hay ganancia garantizada)
 * Negativo = no es un arbitraje (la casa tiene ventaja)
 */
export function calculateArbPercentage(odds: number[]): number {
  if (odds.length < 2) return -Infinity

  const marginSum = odds.reduce((sum, odd) => {
    return sum.plus(new Decimal(1).div(new Decimal(odd)))
  }, new Decimal(0))

  return new Decimal(1).minus(marginSum).mul(100).toNumber()
}

/**
 * Calcula los stakes óptimos para garantizar el mismo retorno
 * independientemente del resultado.
 * Fórmula: stake_i = totalBankroll × (1/odds_i) / sum(1/odds_j)
 */
export function calculateOptimalStakes(odds: number[], totalBankroll: number): number[] {
  const bankroll = new Decimal(totalBankroll)

  const inverseOdds = odds.map((odd) => new Decimal(1).div(new Decimal(odd)))
  const marginSum = inverseOdds.reduce((sum, inv) => sum.plus(inv), new Decimal(0))

  return inverseOdds.map((inv) => bankroll.mul(inv).div(marginSum).toDecimalPlaces(2).toNumber())
}

/**
 * Redondea stakes al múltiplo más cercano de roundTo.
 * roundStake(342.71, 5) → 345
 */
export function roundStake(stake: number, roundTo: number): number {
  const r = new Decimal(roundTo)
  return new Decimal(stake).div(r).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(r).toNumber()
}

/**
 * Calcula el retorno potencial de una apuesta.
 * Fórmula: stake × odds
 */
export function calculatePotentialReturn(stake: number, odds: number): number {
  return new Decimal(stake).mul(new Decimal(odds)).toDecimalPlaces(2).toNumber()
}

/**
 * El retorno garantizado es el mínimo de los retornos potenciales.
 * En un arbitraje perfectamente calculado, todos son iguales.
 * En uno redondeado, pueden diferir ligeramente.
 */
export function calculateExpectedReturn(legs: LegInput[]): number {
  if (legs.length === 0) return 0
  const returns = legs.map((leg) =>
    new Decimal(leg.stake ?? 0).mul(new Decimal(leg.odds)).toNumber(),
  )
  return Math.min(...returns)
}

/**
 * Calcula el beneficio neto de un arbitraje liquidado.
 */
export function calculateProfit(totalReturn: number, totalStake: number): number {
  return new Decimal(totalReturn).minus(new Decimal(totalStake)).toDecimalPlaces(2).toNumber()
}

/**
 * ROI de una operación.
 * (profit / stake) × 100
 */
export function calculateRoi(profit: number, stake: number): number {
  if (stake === 0) return 0
  return new Decimal(profit).div(new Decimal(stake)).mul(100).toDecimalPlaces(4).toNumber()
}

/**
 * Calcula todos los valores de un arbitraje de una sola vez.
 * Esta es la función principal que usa el formulario.
 */
export function calculateArbitrage(
  legs: LegInput[],
  totalBankroll?: number,
): ArbCalculationResult {
  const odds = legs.map((l) => l.odds)
  const inverseOdds = odds.map((o) => new Decimal(1).div(new Decimal(o)))
  const marginSum = inverseOdds.reduce((s, i) => s.plus(i), new Decimal(0))

  const arbPercentage = new Decimal(1).minus(marginSum).mul(100).toDecimalPlaces(4).toNumber()
  const isValidArb = arbPercentage > 0

  const bankroll = totalBankroll ?? legs.reduce((s, l) => s + (l.stake ?? 0), 0)
  const optimalStakes = inverseOdds.map((inv) =>
    new Decimal(bankroll).mul(inv).div(marginSum).toDecimalPlaces(2).toNumber(),
  )
  const optimalStakesRounded = optimalStakes.map((s) => Math.round(s * 100) / 100)

  const totalStake = optimalStakes.reduce((s, st) => s + st, 0)
  const potentialReturns = optimalStakes.map((s, i) =>
    new Decimal(s).mul(new Decimal(odds[i]!)).toNumber(),
  )
  const guaranteedReturn = Math.min(...potentialReturns)
  const guaranteedProfit = calculateProfit(guaranteedReturn, totalStake)
  const roi = calculateRoi(guaranteedProfit, totalStake)

  return {
    arbPercentage,
    isValidArb,
    impliedProbabilities: inverseOdds.map((i) => i.toDecimalPlaces(6).toNumber()),
    marginSum: marginSum.toDecimalPlaces(6).toNumber(),
    optimalStakes,
    optimalStakesRounded,
    totalStake,
    guaranteedReturn,
    guaranteedProfit,
    roi,
  }
}
