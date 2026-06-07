import Decimal from 'decimal.js'

export interface TransactionForReconstruction {
  type: string
  amount: number
  balanceAfter: number
  createdAt: Date
}

export interface BookmakerForBankroll {
  id: string
  currentBalance: number
  currency: string
  pendingStakes?: number
}

export interface BankrollTotals {
  effective: number
  available: number
  inPlay: number
}

/**
 * Reconstruye el balance de un bookmaker reproduciendo sus transacciones en orden.
 * Retorna el balance final calculado.
 * Si difiere de balanceAfter de la última transacción → hay inconsistencia.
 */
export function reconstructBalance(transactions: TransactionForReconstruction[]): number {
  const sorted = [...transactions].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )

  return sorted.reduce((balance, tx) => {
    return new Decimal(balance).plus(new Decimal(tx.amount)).toDecimalPlaces(2).toNumber()
  }, 0)
}

/**
 * Verifica que el balance reconstruido coincide con el almacenado.
 */
export function verifyBalanceIntegrity(
  transactions: TransactionForReconstruction[],
  storedBalance: number,
): { isConsistent: boolean; calculated: number; difference: number } {
  const calculated = reconstructBalance(transactions)
  const difference = new Decimal(calculated).minus(new Decimal(storedBalance)).toNumber()
  const isConsistent = Math.abs(difference) < 0.01 // Tolerancia de 1 céntimo

  return { isConsistent, calculated, difference }
}

/**
 * Calcula el balance disponible (excluyendo stakes en apuestas PENDING).
 */
export function calculateAvailableBalance(
  currentBalance: number,
  pendingStakes: number,
): number {
  const available = new Decimal(currentBalance)
    .minus(new Decimal(pendingStakes))
    .toDecimalPlaces(2)
    .toNumber()
  return Math.max(0, available)
}

/**
 * Agrega los balances de múltiples bookmakers en totales del bankroll.
 * Solo suma bookmakers con la misma moneda que primaryCurrency.
 */
export function calculateTotalBankroll(
  bookmakers: BookmakerForBankroll[],
  primaryCurrency: string,
): BankrollTotals {
  const matching = bookmakers.filter((bm) => bm.currency === primaryCurrency)

  const effective = matching.reduce(
    (sum, bm) => new Decimal(sum).plus(new Decimal(bm.currentBalance)).toNumber(),
    0,
  )

  const inPlay = matching.reduce(
    (sum, bm) => new Decimal(sum).plus(new Decimal(bm.pendingStakes ?? 0)).toNumber(),
    0,
  )

  const available = calculateAvailableBalance(effective, inPlay)

  return {
    effective: new Decimal(effective).toDecimalPlaces(2).toNumber(),
    available: new Decimal(available).toDecimalPlaces(2).toNumber(),
    inPlay: new Decimal(inPlay).toDecimalPlaces(2).toNumber(),
  }
}

/**
 * ROI de un bookmaker específico.
 */
export function calculateBookmakerRoi(totalProfit: number, totalStaked: number): number {
  if (totalStaked === 0) return 0
  return new Decimal(totalProfit).div(new Decimal(totalStaked)).mul(100).toDecimalPlaces(4).toNumber()
}

/**
 * Capital neto aportado = depósitos + bonos - retiradas.
 * No incluye BET_PLACED ni BET_RETURN (son movimientos internos).
 */
export function calculateInitialCapital(transactions: TransactionForReconstruction[]): number {
  const capitalTypes = new Set(['INITIAL_DEPOSIT', 'DEPOSIT', 'WITHDRAWAL', 'BONUS'])

  return transactions
    .filter((tx) => capitalTypes.has(tx.type))
    .reduce((sum, tx) => new Decimal(sum).plus(new Decimal(tx.amount)).toNumber(), 0)
}
