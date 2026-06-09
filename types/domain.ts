// ════════════════════════════════════════════════════════════════════
// ENUMS — espejo de prisma/schema.prisma (sin importar @prisma/client
// para que este archivo sea consumible tanto desde RSC como desde
// Client Components y archivos de prueba sin efectos secundarios)
// ════════════════════════════════════════════════════════════════════

export type UserPlan = 'FREE' | 'PRO' | 'PRO_TRACKER' | 'ENTERPRISE'

export type BookmakerStatus = 'ACTIVE' | 'LIMITED' | 'GUBBED' | 'CLOSED' | 'SUSPENDED'

export type BetType = 'ARBITRAGE' | 'MIDDLE' | 'SINGLE' | 'COMBO' | 'CASINO' | 'CUSTOM'

export type BetStatus =
  | 'PLACED'
  | 'WON'
  | 'LOST'
  | 'VOID'
  | 'CASHOUT'
  | 'PARTIAL_WIN'

export type MarketType =
  | 'MATCH_RESULT'
  | 'DOUBLE_CHANCE'
  | 'OVER_UNDER'
  | 'BOTH_TEAMS_SCORE'
  | 'HANDICAP'
  | 'ASIAN_HANDICAP'
  | 'CORRECT_SCORE'
  | 'OUTRIGHT'
  | 'PLAYER_PROP'
  | 'MONEYLINE'
  | 'SPREAD'
  | 'OTHER'

export type CasinoGameType =
  | 'SLOTS'
  | 'ROULETTE'
  | 'BLACKJACK'
  | 'BACCARAT'
  | 'POKER'
  | 'LIVE_CASINO'
  | 'DICE'
  | 'BONUS_BUY'
  | 'OTHER'

export type SportType =
  | 'FOOTBALL'
  | 'TENNIS'
  | 'BASKETBALL'
  | 'BASEBALL'
  | 'HOCKEY'
  | 'CRICKET'
  | 'RUGBY'
  | 'GOLF'
  | 'MMA'
  | 'BOXING'
  | 'CYCLING'
  | 'MOTORSPORT'
  | 'ESPORTS'
  | 'OTHER'

export type TransactionType =
  | 'INITIAL_DEPOSIT'
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'BONUS'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'BET_PLACED'
  | 'BET_RETURN'
  | 'BET_VOID_RETURN'
  | 'CASHOUT'
  | 'MANUAL_ADJUSTMENT'

export type CreatedVia = 'MANUAL' | 'TELEGRAM_BOT' | 'API_KEY' | 'CSV_IMPORT'

// ════════════════════════════════════════════════════════════════════
// ENTIDADES BASE
// Todos los campos financieros son number (post-serialización Decimal).
// Dentro del ORM son Prisma.Decimal; usar serializePrisma() antes de
// cruzar el boundary RSC → Client Component.
// ════════════════════════════════════════════════════════════════════

export interface Bookmaker {
  id: string
  userId: string
  name: string
  country: string | null
  currency: string
  color: string | null
  logoUrl: string | null
  websiteUrl: string | null
  notes: string | null
  status: BookmakerStatus
  // CRÍTICO: actualizar siempre con { increment } / { decrement } atómicos
  currentBalance: number
  // Stats denormalizadas — actualizadas con { increment } en cada settlement
  totalProfit: number
  totalStaked: number
  totalReturn: number  // permite calcular yield sin queries extra
  operationCount: number
  createdAt: Date
  updatedAt: Date
}

export interface BetRecord {
  id: string
  userId: string
  type: BetType
  status: BetStatus
  title: string | null
  notes: string | null
  sport: SportType | null
  competition: string | null
  eventName: string | null
  eventDate: Date | null
  // Financiero core — grossProfit y totalReturn son null hasta settlement
  totalStake: number
  potentialReturn: number | null
  grossProfit: number | null
  totalReturn: number | null
  roi: number | null
  datePlaced: Date
  dateSettled: Date | null
  createdVia: CreatedVia
  externalRef: string | null
  deletedAt: Date | null
  primaryBookmakerId: string | null
}

export interface BetLeg {
  id: string
  betRecordId: string
  bookmakerId: string
  selection: string
  odds: number
  stake: number
  potentialReturn: number
  currency: string
  status: BetStatus
  cashoutAmount: number | null
  deletedAt: Date | null
}

// ════════════════════════════════════════════════════════════════════
// SATÉLITES DE TIPO (post-serialización)
// ════════════════════════════════════════════════════════════════════

export interface ArbitrageDetail {
  id: string
  betRecordId: string
  arbPercentage: number
  expectedReturn: number
  winningLegId: string | null
}

export interface MiddleDetail {
  id: string
  betRecordId: string
  middleRange: string
  worstCaseLoss: number
  bestCaseProfit: number
  middleHit: boolean | null
  winningLegId: string | null
}

export interface SingleBetDetail {
  id: string
  betRecordId: string
  selection: string
  odds: number
  marketType: MarketType
  isFreeBet: boolean
  freeBetValue: number | null
}

export interface ComboDetail {
  id: string
  betRecordId: string
  totalOdds: number
  legCount: number
  comboType: string
  eachWay: boolean
}

export interface CasinoDetail {
  id: string
  betRecordId: string
  gameType: CasinoGameType
  gameName: string | null
  sessionDuration: number | null
  initialBalance: number | null
  finalBalance: number | null
  avgBetSize: number | null
  numberOfBets: number | null
  bonusUsed: boolean
  bonusAmount: number | null
}

export interface BetBookmakerAllocation {
  id: string
  betRecordId: string
  bookmakerId: string
  stakeAllocated: number
  returnAllocated: number | null
  profitAllocated: number | null
}

// ════════════════════════════════════════════════════════════════════
// TIPOS COMPUESTOS — VISTAS DE LISTA
// ════════════════════════════════════════════════════════════════════

export type BookmakerSummary = Pick<
  Bookmaker,
  'id' | 'name' | 'color' | 'currency' | 'status'
>

/** Pierna para visualizar en la lista de registros recientes */
export interface BetLegListItem {
  id: string
  selection: string
  odds: number
  stake: number
  potentialReturn: number
  status: BetStatus
  bookmaker: BookmakerSummary
}

/** Registro de apuesta enriquecido para la lista del dashboard */
export interface BetRecordListItem {
  id: string
  type: BetType
  status: BetStatus
  sport: SportType | null
  competition: string | null
  eventName: string | null
  title: string | null
  totalStake: number
  potentialReturn: number | null
  grossProfit: number | null
  totalReturn: number | null
  roi: number | null
  datePlaced: Date
  dateSettled: Date | null
  createdVia: CreatedVia
  primaryBookmaker: BookmakerSummary | null
  legs: BetLegListItem[]
  arbitrageDetail: Pick<ArbitrageDetail, 'arbPercentage' | 'expectedReturn' | 'winningLegId'> | null
  middleDetail: Pick<MiddleDetail, 'middleRange' | 'worstCaseLoss' | 'bestCaseProfit' | 'middleHit'> | null
  singleBetDetail: Pick<SingleBetDetail, 'selection' | 'odds' | 'marketType' | 'isFreeBet'> | null
}

// ════════════════════════════════════════════════════════════════════
// ANALYTICS — TIPOS DEL DASHBOARD v2.1
// ════════════════════════════════════════════════════════════════════

/**
 * Métricas globales del bankroll.
 * Todas las fórmulas siguen la metodología del Blueprint v2.1.
 */
export interface BankrollMetrics {
  /** Suma de todas las transacciones INITIAL_DEPOSIT */
  initialCapital: number
  /** Suma de currentBalance de todos los bookmakers */
  currentTotal: number
  /** Stakes de BetRecords en estado PLACED (dinero comprometido) */
  totalInPlay: number
  /** currentTotal - totalInPlay */
  availableTotal: number
  /** Suma de grossProfit de todos los registros liquidados */
  netProfit: number
  /** Suma de totalStake de todos los registros liquidados */
  totalStaked: number
  /** Suma de totalReturn de todos los registros liquidados */
  totalReturn: number
  /** netProfit / initialCapital × 100 */
  roi: number
  /** netProfit / totalStaked × 100 — rendimiento sobre el turnover */
  yield: number
  /** (currentTotal - initialCapital) / initialCapital × 100 */
  accumulatedReturn: number
}

/** Desglose de P&L por tipo de apuesta */
export interface TypeBreakdown {
  type: BetType
  settledCount: number
  profit: number
  staked: number
  return: number
  /** profit / staked × 100 */
  yield: number
}

/** Stats de un bookmaker individual para la sección 3 del dashboard */
export interface BookmakerBreakdown {
  id: string
  name: string
  color: string | null
  currency: string
  status: BookmakerStatus
  currentBalance: number
  totalProfit: number
  totalStaked: number
  totalReturn: number
  /** totalProfit / totalStaked × 100 */
  yield: number
  operationCount: number
}

/** Resumen de un período (día/semana/mes) */
export interface PeriodStat {
  /** 'YYYY-MM-DD' para días, 'YYYY-MM' para meses, 'W-YYYY-MM-DD' para semanas */
  period: string
  profit: number
  operationCount: number
}

/** Métricas de rachas */
export interface StreakMetrics {
  currentWin: number
  currentLoss: number
  maxWin: number
  maxLoss: number
}

/** Métricas de una ventana temporal (7d, 30d) */
export interface WindowMetrics {
  profit: number
  staked: number
  operations: number
}

/** Desglose de P&L por deporte */
export interface SportBreakdown {
  sport: SportType
  count: number
  profit: number
  staked: number
  /** profit / staked × 100 */
  yield: number
}

/** Estadísticas avanzadas (Sección 4 del dashboard) */
export interface AdvancedStats {
  totalOperations: number
  settledOperations: number
  placedOperations: number
  activeDays: number
  avgDailyProfit: number
  avgWeeklyProfit: number
  avgMonthlyProfit: number
  maxDrawdown: number
  streaks: StreakMetrics
  bestDay: PeriodStat | null
  worstDay: PeriodStat | null
  bestWeek: PeriodStat | null
  worstWeek: PeriodStat | null
  bestMonth: PeriodStat | null
  worstMonth: PeriodStat | null
  bySport: SportBreakdown[]
  last7: WindowMetrics
  last30: WindowMetrics
}

/**
 * Tipo de retorno principal de getDashboardMetrics.
 * Estructura completa del dashboard v2.1.
 */
export interface DashboardMetrics {
  bankroll: BankrollMetrics
  byType: TypeBreakdown[]
  byBookmaker: BookmakerBreakdown[]
  advanced: AdvancedStats
}
