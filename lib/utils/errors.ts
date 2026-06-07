export const ErrorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',

  PLAN_LIMIT_ARBITRAGES: 'PLAN_LIMIT_ARBITRAGES',
  PLAN_LIMIT_BOOKMAKERS: 'PLAN_LIMIT_BOOKMAKERS',
  PLAN_FEATURE_LOCKED: 'PLAN_FEATURE_LOCKED',

  ARBITRAGE_NOT_FOUND: 'ARBITRAGE_NOT_FOUND',
  ARBITRAGE_NOT_PENDING: 'ARBITRAGE_NOT_PENDING',
  ARBITRAGE_ALREADY_SETTLED: 'ARBITRAGE_ALREADY_SETTLED',
  INVALID_ARB_PERCENTAGE: 'INVALID_ARB_PERCENTAGE',
  MIN_LEGS_REQUIRED: 'MIN_LEGS_REQUIRED',
  INVALID_ODDS: 'INVALID_ODDS',
  INVALID_STAKE: 'INVALID_STAKE',

  BOOKMAKER_NOT_FOUND: 'BOOKMAKER_NOT_FOUND',
  BOOKMAKER_NOT_OWNED: 'BOOKMAKER_NOT_OWNED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',

  SETTLEMENT_INVALID_LEG: 'SETTLEMENT_INVALID_LEG',
  VOID_REQUIRES_PENDING: 'VOID_REQUIRES_PENDING',

  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: Record<string, string[]>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

export function toActionError(error: unknown): { error: string; code: string } {
  if (isAppError(error)) {
    return { error: error.message, code: error.code }
  }
  console.error('Unexpected error:', error)
  return { error: 'Error interno del servidor', code: ErrorCodes.INTERNAL_ERROR }
}
