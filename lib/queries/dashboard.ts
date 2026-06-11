/**
 * lib/queries/dashboard.ts
 *
 * Motor de lectura del dashboard v2.1.
 * Todas las operaciones financieras usan Decimal.js (precisión 20, ROUND_HALF_UP)
 * para evitar acumulación de errores de coma flotante IEEE 754.
 *
 * REGLA DE USO:
 * - getDashboardMetrics()  → devuelve solo `number` (ya computado). No necesita serializePrisma().
 * - getRecentBetRecords()  → devuelve datos serializados internamente. No necesita serializePrisma().
 * - getBookmakerBreakdown() → ídem.
 */

import Decimal from 'decimal.js'
import { prisma } from '@/lib/db/client'
import { type Prisma } from '@prisma/client'
import {
  calculateMaxDrawdown,
  calculateStreaks,
} from '@/lib/calculations/analytics'
import { serializePrisma } from '@/lib/utils/serialize'
import type {
  DashboardMetrics,
  BankrollMetrics,
  TypeBreakdown,
  BookmakerBreakdown,
  AdvancedStats,
  PeriodStat,
  SportBreakdown,
  WindowMetrics,
  StreakMetrics,
  BetRecordListItem,
  BetType,
  SportType,
  BookmakerStatus,
} from '@/types/domain'

// ─── Configuración global de Decimal.js ─────────────────────────────────────
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP })

// ─── Helper de conversión: Prisma.Decimal | null | number → Decimal.js ───────
// Devuelve Decimal(0) para null/undefined en lugar de lanzar excepción.
// Compatible con noUncheckedIndexedAccess ya que nunca accede a índices.
function D(v: { toString(): string } | number | null | undefined): Decimal {
  if (v === null || v === undefined) return new Decimal(0)
  return new Decimal(typeof v === 'number' ? String(v) : v.toString())
}

// ─── Claves de período ───────────────────────────────────────────────────────

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10) // 'YYYY-MM-DD'
}

function weekKey(d: Date): string {
  // Devuelve la fecha del lunes de la semana (UTC) que contiene `d`
  const dt = new Date(d)
  const dow = dt.getUTCDay() // 0=Dom, 1=Lun, ..., 6=Sáb
  const offset = dow === 0 ? 6 : dow - 1
  dt.setUTCDate(dt.getUTCDate() - offset)
  return `W${dt.toISOString().slice(0, 10)}` // ej: 'W2026-06-01'
}

function monthKey(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}` // 'YYYY-MM'
}

// ─── Acumulación por período ─────────────────────────────────────────────────

interface PeriodEntry {
  profit: Decimal
  count: number
}

type SettledRecord = {
  grossProfit: { toString(): string } | null
  dateSettled: Date | null
}

function buildPeriodMap(
  records: readonly SettledRecord[],
  keyFn: (date: Date) => string,
): Map<string, PeriodEntry> {
  const map = new Map<string, PeriodEntry>()
  for (const r of records) {
    if (r.dateSettled === null) continue
    const key = keyFn(r.dateSettled)
    const ex = map.get(key) ?? { profit: new Decimal(0), count: 0 }
    map.set(key, {
      profit: ex.profit.plus(D(r.grossProfit)),
      count: ex.count + 1,
    })
  }
  return map
}

function findBestWorst(map: Map<string, PeriodEntry>): {
  best: PeriodStat | null
  worst: PeriodStat | null
} {
  let best: PeriodStat | null = null
  let worst: PeriodStat | null = null

  for (const [period, { profit, count }] of map) {
    const p = profit.toDecimalPlaces(2).toNumber()
    if (best === null || p > best.profit) best = { period, profit: p, operationCount: count }
    if (worst === null || p < worst.profit) worst = { period, profit: p, operationCount: count }
  }

  return { best, worst }
}

// ─── Suma con Decimal de un array de Prisma.Decimal | null ──────────────────

function sumD(values: ReadonlyArray<{ toString(): string } | null | undefined>): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(D(v)), new Decimal(0))
}

// ════════════════════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Calcula todas las métricas del dashboard en una única llamada.
 *
 * Estrategia: 5 queries en paralelo (Promise.all) → computación en memoria
 * con Decimal.js → retorna solo `number` (sin Prisma.Decimal).
 *
 * No se necesita serializePrisma() sobre el resultado de esta función.
 */
export async function getDashboardMetrics(
  userId: string,
  bankrollId?: string,
): Promise<DashboardMetrics> {
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  // ── Bankroll filter: resolve bookmaker IDs if filtering by bankroll ───────
  let bmIdFilter: string[] | undefined
  if (bankrollId) {
    const bankroll = await prisma.bankroll.findFirst({
      where: { id: bankrollId, userId },
      select: { id: true },
    })
    if (bankroll) {
      const bms = await prisma.bookmaker.findMany({
        where: { userId, bankrollId },
        select: { id: true },
      })
      bmIdFilter = bms.map((b) => b.id)
    }
  }

  // Build reusable where clauses
  const bmWhere: Prisma.BookmakerWhereInput = bmIdFilter
    ? { userId, id: { in: bmIdFilter } }
    : { userId }

  const betBmExtra: Prisma.BetRecordWhereInput = bmIdFilter
    ? {
        OR: [
          { primaryBookmakerId: { in: bmIdFilter } },
          { legs: { some: { bookmakerId: { in: bmIdFilter } } } },
        ],
      }
    : {}

  // ── Parallel queries ──────────────────────────────────────────────────────
  const [bookmakers, capitalSum, settledRecords, inPlayAgg, statusCounts] = await Promise.all([

    // 1. Bookmakers: saldos actuales y stats denormalizadas
    prisma.bookmaker.findMany({
      where: bmWhere,
      select: {
        id: true,
        name: true,
        color: true,
        currency: true,
        status: true,
        currentBalance: true,
        totalProfit: true,
        totalStaked: true,
        totalReturn: true,
        operationCount: true,
      },
    }),

    // 2. Capital inicial: SOLO transacciones INITIAL_DEPOSIT
    prisma.bookmakerTransaction.aggregate({
      where: {
        userId,
        type: 'INITIAL_DEPOSIT',
        ...(bmIdFilter ? { bookmakerId: { in: bmIdFilter } } : {}),
      },
      _sum: { amount: true },
    }),

    // 3. Registros liquidados — fuente de verdad para P&L
    prisma.betRecord.findMany({
      where: {
        userId,
        status: { in: ['WON', 'LOST', 'CASHOUT'] },
        deletedAt: null,
        ...betBmExtra,
      },
      select: {
        type: true,
        sport: true,
        grossProfit: true,
        totalStake: true,
        totalReturn: true,
        dateSettled: true,
      },
      orderBy: { dateSettled: 'asc' },
    }),

    // 4. Apuestas en juego
    prisma.betRecord.aggregate({
      where: { userId, status: 'PLACED', deletedAt: null, ...betBmExtra },
      _sum: { totalStake: true },
      _count: { id: true },
    }),

    // 5. Conteo por estado
    prisma.betRecord.groupBy({
      by: ['status'],
      where: { userId, deletedAt: null, ...betBmExtra },
      _count: { id: true },
    }),

  ])

  // ────────────────────────────────────────────────────────────────────────
  // SECCIÓN 1 — BANKROLL GLOBAL
  // ────────────────────────────────────────────────────────────────────────

  const initialCapital = D(capitalSum._sum.amount)
  const currentTotal = bookmakers.reduce(
    (sum, bm) => sum.plus(D(bm.currentBalance)),
    new Decimal(0),
  )
  const totalInPlay = D(inPlayAgg._sum.totalStake)
  const availableTotal = currentTotal.minus(totalInPlay)

  // Métricas derivadas de los registros liquidados
  const netProfit = sumD(settledRecords.map((r) => r.grossProfit))
  const totalStaked = sumD(settledRecords.map((r) => r.totalStake))
  const totalReturnAgg = sumD(settledRecords.map((r) => r.totalReturn))

  const roi = initialCapital.isZero()
    ? new Decimal(0)
    : netProfit.div(initialCapital).mul(100).toDecimalPlaces(4)

  const yieldPct = totalStaked.isZero()
    ? new Decimal(0)
    : netProfit.div(totalStaked).mul(100).toDecimalPlaces(4)

  const accumulatedReturn = initialCapital.isZero()
    ? new Decimal(0)
    : currentTotal.minus(initialCapital).div(initialCapital).mul(100).toDecimalPlaces(4)

  const bankroll: BankrollMetrics = {
    initialCapital:    initialCapital.toDecimalPlaces(2).toNumber(),
    currentTotal:      currentTotal.toDecimalPlaces(2).toNumber(),
    totalInPlay:       totalInPlay.toDecimalPlaces(2).toNumber(),
    availableTotal:    availableTotal.toDecimalPlaces(2).toNumber(),
    netProfit:         netProfit.toDecimalPlaces(2).toNumber(),
    totalStaked:       totalStaked.toDecimalPlaces(2).toNumber(),
    totalReturn:       totalReturnAgg.toDecimalPlaces(2).toNumber(),
    roi:               roi.toNumber(),
    yield:             yieldPct.toNumber(),
    accumulatedReturn: accumulatedReturn.toNumber(),
  }

  // ────────────────────────────────────────────────────────────────────────
  // SECCIÓN 2 — DESGLOSE POR TIPO DE APUESTA
  // ────────────────────────────────────────────────────────────────────────

  const typeMap = new Map<
    string,
    { count: number; profit: Decimal; staked: Decimal; return: Decimal }
  >()

  for (const r of settledRecords) {
    const ex = typeMap.get(r.type) ?? {
      count: 0,
      profit: new Decimal(0),
      staked: new Decimal(0),
      return: new Decimal(0),
    }
    typeMap.set(r.type, {
      count:  ex.count + 1,
      profit: ex.profit.plus(D(r.grossProfit)),
      staked: ex.staked.plus(D(r.totalStake)),
      return: ex.return.plus(D(r.totalReturn)),
    })
  }

  const byType: TypeBreakdown[] = Array.from(typeMap.entries()).map(
    ([type, { count, profit, staked, return: ret }]) => ({
      type:         type as BetType,
      settledCount: count,
      profit:       profit.toDecimalPlaces(2).toNumber(),
      staked:       staked.toDecimalPlaces(2).toNumber(),
      return:       ret.toDecimalPlaces(2).toNumber(),
      yield: staked.isZero()
        ? 0
        : profit.div(staked).mul(100).toDecimalPlaces(4).toNumber(),
    }),
  )

  // ────────────────────────────────────────────────────────────────────────
  // SECCIÓN 3 — DESGLOSE POR BOOKMAKER
  // Usa las stats denormalizadas de Bookmaker (totalProfit, totalStaked, totalReturn)
  // que se mantienen actualizadas con operaciones atómicas { increment }.
  // ────────────────────────────────────────────────────────────────────────

  const byBookmaker: BookmakerBreakdown[] = bookmakers.map((bm) => {
    const profit = D(bm.totalProfit)
    const staked = D(bm.totalStaked)

    return {
      id:             bm.id,
      name:           bm.name,
      color:          bm.color,
      currency:       bm.currency,
      status:         bm.status as BookmakerStatus,
      currentBalance: D(bm.currentBalance).toDecimalPlaces(2).toNumber(),
      totalProfit:    profit.toDecimalPlaces(2).toNumber(),
      totalStaked:    staked.toDecimalPlaces(2).toNumber(),
      totalReturn:    D(bm.totalReturn).toDecimalPlaces(2).toNumber(),
      yield: staked.isZero()
        ? 0
        : profit.div(staked).mul(100).toDecimalPlaces(4).toNumber(),
      operationCount: bm.operationCount,
    }
  })

  // ────────────────────────────────────────────────────────────────────────
  // SECCIÓN 4 — ESTADÍSTICAS AVANZADAS
  // ────────────────────────────────────────────────────────────────────────

  // ── 4a. Conteos de operaciones ─────────────────────────────────────
  const countByStatus = (status: string): number =>
    statusCounts.find((g) => g.status === status)?._count.id ?? 0

  const settledCount = countByStatus('WON') + countByStatus('LOST') + countByStatus('CASHOUT')
  const placedCount  = inPlayAgg._count.id
  const totalCount   = statusCounts.reduce((sum, g) => sum + g._count.id, 0)

  // ── 4b. Períodos activos y promedios ──────────────────────────────
  const daySet = new Set<string>()
  const weekSet = new Set<string>()
  const monthSet = new Set<string>()

  for (const r of settledRecords) {
    if (r.dateSettled === null) continue
    daySet.add(dayKey(r.dateSettled))
    weekSet.add(weekKey(r.dateSettled))
    monthSet.add(monthKey(r.dateSettled))
  }

  const activeDays = daySet.size

  const avgDailyProfit = activeDays > 0
    ? netProfit.div(activeDays).toDecimalPlaces(2).toNumber()
    : 0

  const avgWeeklyProfit = weekSet.size > 0
    ? netProfit.div(weekSet.size).toDecimalPlaces(2).toNumber()
    : 0

  const avgMonthlyProfit = monthSet.size > 0
    ? netProfit.div(monthSet.size).toDecimalPlaces(2).toNumber()
    : 0

  // ── 4c. Rachas (usando series ordenadas ASC por dateSettled) ───────
  const grossProfits = settledRecords.map((r) => D(r.grossProfit).toNumber())
  const { currentWinStreak, currentLossStreak, maxWinStreak, maxLossStreak } =
    calculateStreaks(grossProfits)

  const streaks: StreakMetrics = {
    currentWin:  currentWinStreak,
    currentLoss: currentLossStreak,
    maxWin:      maxWinStreak,
    maxLoss:     maxLossStreak,
  }

  // ── 4d. Max drawdown sobre la serie acumulada ─────────────────────
  let runningSum = new Decimal(0)
  const cumulativeSeries = grossProfits.map((p) => {
    runningSum = runningSum.plus(new Decimal(p))
    return runningSum.toDecimalPlaces(2).toNumber()
  })
  const maxDrawdown = calculateMaxDrawdown(cumulativeSeries)

  // ── 4e. Mejor / peor día, semana, mes ────────────────────────────
  const dayMap   = buildPeriodMap(settledRecords, dayKey)
  const weekMap  = buildPeriodMap(settledRecords, weekKey)
  const monthMap = buildPeriodMap(settledRecords, monthKey)

  const { best: bestDay,   worst: worstDay }   = findBestWorst(dayMap)
  const { best: bestWeek,  worst: worstWeek }  = findBestWorst(weekMap)
  const { best: bestMonth, worst: worstMonth } = findBestWorst(monthMap)

  // ── 4g. Desglose por deporte ──────────────────────────────────────
  const sportMap = new Map<string, { count: number; profit: Decimal; staked: Decimal }>()

  for (const r of settledRecords) {
    if (r.sport === null) continue // CASINO no tiene deporte
    const ex = sportMap.get(r.sport) ?? {
      count: 0,
      profit: new Decimal(0),
      staked: new Decimal(0),
    }
    sportMap.set(r.sport, {
      count:  ex.count + 1,
      profit: ex.profit.plus(D(r.grossProfit)),
      staked: ex.staked.plus(D(r.totalStake)),
    })
  }

  const bySport: SportBreakdown[] = Array.from(sportMap.entries()).map(
    ([sport, { count, profit, staked }]) => ({
      sport:  sport as SportType,
      count,
      profit: profit.toDecimalPlaces(2).toNumber(),
      staked: staked.toDecimalPlaces(2).toNumber(),
      yield: staked.isZero()
        ? 0
        : profit.div(staked).mul(100).toDecimalPlaces(4).toNumber(),
    }),
  )

  // ── 4h. Ventanas temporales (últimos 7 y 30 días) ─────────────────
  // Usa closure sobre settledRecords para evitar anotar el tipo Prisma complejo.
  function windowFor(from: Date): WindowMetrics {
    const slice = settledRecords.filter(
      (r) => r.dateSettled !== null && r.dateSettled >= from,
    )
    return {
      profit:     sumD(slice.map((r) => r.grossProfit)).toDecimalPlaces(2).toNumber(),
      staked:     sumD(slice.map((r) => r.totalStake)).toDecimalPlaces(2).toNumber(),
      operations: slice.length,
    }
  }

  const last7  = windowFor(sevenDaysAgo)
  const last30 = windowFor(thirtyDaysAgo)

  const advanced: AdvancedStats = {
    totalOperations:   totalCount,
    settledOperations: settledCount,
    placedOperations:  placedCount,
    activeDays,
    avgDailyProfit,
    avgWeeklyProfit,
    avgMonthlyProfit,
    maxDrawdown,
    streaks,
    bestDay,
    worstDay,
    bestWeek,
    worstWeek,
    bestMonth,
    worstMonth,
    bySport,
    last7,
    last30,
  }

  return { bankroll, byType, byBookmaker, advanced }
}

// ════════════════════════════════════════════════════════════════════════════
// REGISTROS RECIENTES — para la tabla principal del dashboard
// ════════════════════════════════════════════════════════════════════════════

/**
 * Devuelve los N registros más recientes del usuario, enriquecidos con
 * sus satélites y piernas.
 *
 * serializePrisma() se aplica internamente: el resultado es directamente
 * consumible por Client Components.
 */
export async function getRecentBetRecords(
  userId: string,
  limit = 10,
): Promise<BetRecordListItem[]> {
  const raw = await prisma.betRecord.findMany({
    where: { userId, deletedAt: null },
    orderBy: { datePlaced: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      status: true,
      sport: true,
      competition: true,
      eventName: true,
      title: true,
      totalStake: true,
      potentialReturn: true,
      grossProfit: true,
      totalReturn: true,
      roi: true,
      datePlaced: true,
      dateSettled: true,
      createdVia: true,
      primaryBookmaker: {
        select: {
          id: true,
          name: true,
          color: true,
          currency: true,
          status: true,
        },
      },
      legs: {
        where: { deletedAt: null },
        select: {
          id: true,
          selection: true,
          odds: true,
          stake: true,
          potentialReturn: true,
          status: true,
          bookmaker: {
            select: {
              id: true,
              name: true,
              color: true,
              currency: true,
              status: true,
            },
          },
        },
      },
      arbitrageDetail: {
        select: {
          arbPercentage: true,
          expectedReturn: true,
          winningLegId: true,
        },
      },
      middleDetail: {
        select: {
          middleRange: true,
          worstCaseLoss: true,
          bestCaseProfit: true,
          middleHit: true,
        },
      },
      singleBetDetail: {
        select: {
          selection: true,
          odds: true,
          marketType: true,
          isFreeBet: true,
        },
      },
    },
  })

  // Convierte Prisma.Decimal → number antes de cruzar el boundary RSC → Client
  return serializePrisma(raw) as unknown as BetRecordListItem[]
}

// ════════════════════════════════════════════════════════════════════════════
// DESGLOSE POR BOOKMAKER — reutilizable en la página /bookmakers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Devuelve las métricas de cada bookmaker del usuario.
 * Usa las stats denormalizadas del modelo Bookmaker (actualización atómica
 * en cada settlement). Sin queries adicionales a BetRecord.
 */
export async function getBookmakerBreakdown(
  userId: string,
): Promise<BookmakerBreakdown[]> {
  const bookmakers = await prisma.bookmaker.findMany({
    where: { userId },
    orderBy: { currentBalance: 'desc' },
    select: {
      id: true,
      name: true,
      color: true,
      currency: true,
      status: true,
      currentBalance: true,
      totalProfit: true,
      totalStaked: true,
      totalReturn: true,
      operationCount: true,
    },
  })

  return bookmakers.map((bm) => {
    const profit = D(bm.totalProfit)
    const staked = D(bm.totalStaked)

    return {
      id:             bm.id,
      name:           bm.name,
      color:          bm.color,
      currency:       bm.currency,
      status:         bm.status as BookmakerStatus,
      currentBalance: D(bm.currentBalance).toDecimalPlaces(2).toNumber(),
      totalProfit:    profit.toDecimalPlaces(2).toNumber(),
      totalStaked:    staked.toDecimalPlaces(2).toNumber(),
      totalReturn:    D(bm.totalReturn).toDecimalPlaces(2).toNumber(),
      yield: staked.isZero()
        ? 0
        : profit.div(staked).mul(100).toDecimalPlaces(4).toNumber(),
      operationCount: bm.operationCount,
    }
  })
}

// ════════════════════════════════════════════════════════════════════════════
// getBankrollEvolution
// Devuelve la evolución del saldo total del bankroll día a día.
// Fuente primaria: DailySnapshot (pre-computado por el cron diario).
// Fallback: reconstrucción desde BetRecord + INITIAL_DEPOSIT si no hay snapshots.
// ════════════════════════════════════════════════════════════════════════════

export interface BalancePoint {
  date:    string  // 'dd/MM'
  dateISO: string  // 'YYYY-MM-DD' — usado para filtrado por rango personalizado
  balance: number  // saldo efectivo total a cierre del día
  pnl:     number  // P&L acumulado hasta ese día
}

export async function getBankrollEvolution(
  userId: string,
  days = 9999,
): Promise<{ points: BalancePoint[]; initialCapital: number }> {
  const since = new Date()
  since.setDate(since.getDate() - days)

  // ── Capital inicial (necesario para la línea de referencia) ──────────────
  const capitalSum = await prisma.bookmakerTransaction.aggregate({
    where: { userId, type: 'INITIAL_DEPOSIT' },
    _sum: { amount: true },
  })
  const initialCapital = D(capitalSum._sum.amount).toDecimalPlaces(2).toNumber()

  // ── Intentar DailySnapshot primero ───────────────────────────────────────
  // wrapped in try/catch: table might not exist yet if db push hasn't run in prod
  type SnapshotRow = { date: Date; totalEffectiveBalance: { toString(): string }; cumulativeProfit: { toString(): string } }
  let snapshots: SnapshotRow[] = []
  try {
    snapshots = await prisma.dailySnapshot.findMany({
      where: { userId, date: { gte: since } },
      select: { date: true, totalEffectiveBalance: true, cumulativeProfit: true },
      orderBy: { date: 'asc' },
    })
  } catch {
    // DailySnapshot table not yet created in this env — fall through to BetRecord fallback
  }

  if (snapshots.length >= 2) {
    const points = snapshots.map((s) => {
      const iso   = s.date.toISOString().slice(0, 10)
      const parts = iso.split('-')
      return {
        date:    `${parts[2]}/${parts[1]}`,
        dateISO: iso,
        balance: D(s.totalEffectiveBalance).toDecimalPlaces(2).toNumber(),
        pnl:     D(s.cumulativeProfit).toDecimalPlaces(2).toNumber(),
      }
    })
    return { points, initialCapital }
  }

  // ── Fallback: reconstruir desde BetRecord ─────────────────────────────────
  const records = await prisma.betRecord.findMany({
    where: {
      userId,
      deletedAt: null,
      dateSettled: { gte: since },
      status:      { in: ['WON', 'LOST', 'CASHOUT'] },
      grossProfit: { not: null },
    },
    select: { dateSettled: true, grossProfit: true },
    orderBy: { dateSettled: 'asc' },
  })

  if (records.length === 0) return { points: [], initialCapital }

  const dailyMap = new Map<string, Decimal>()
  for (const r of records) {
    if (!r.dateSettled || r.grossProfit === null) continue
    const key  = r.dateSettled.toISOString().slice(0, 10)
    const prev = dailyMap.get(key) ?? D(0)
    dailyMap.set(key, prev.plus(D(r.grossProfit)))
  }

  const sortedKeys = Array.from(dailyMap.keys()).sort()
  let cumPnl = D(0)
  const points: BalancePoint[] = []

  for (const key of sortedKeys) {
    const daily = dailyMap.get(key) ?? D(0)
    cumPnl = cumPnl.plus(daily).toDecimalPlaces(2)
    const parts = key.split('-')
    points.push({
      date:    `${parts[2]}/${parts[1]}`,
      dateISO: key,
      balance: D(initialCapital).plus(cumPnl).toDecimalPlaces(2).toNumber(),
      pnl:     cumPnl.toNumber(),
    })
  }

  return { points, initialCapital }
}

// ════════════════════════════════════════════════════════════════════════════
// getProfitTimeSeries
// Devuelve puntos de P&L acumulado día a día para el LineChart del dashboard.
// Solo considera operaciones liquidadas (con dateSettled y grossProfit).
// ════════════════════════════════════════════════════════════════════════════

export interface ProfitPoint {
  date:        string  // 'dd/MM' — etiqueta del eje X
  dailyProfit: number  // P&L neto de ese día
  cumulative:  number  // P&L acumulado hasta ese día
}

export async function getProfitTimeSeries(
  userId: string,
  days = 60,
): Promise<ProfitPoint[]> {
  const since = new Date()
  since.setDate(since.getDate() - days)

  const records = await prisma.betRecord.findMany({
    where: {
      userId,
      deletedAt: null,
      dateSettled: { gte: since },
      status:      { in: ['WON', 'LOST', 'VOID', 'CASHOUT', 'PARTIAL_WIN'] },
      grossProfit: { not: null },
    },
    select: { dateSettled: true, grossProfit: true },
    orderBy: { dateSettled: 'asc' },
  })

  if (records.length === 0) return []

  // Group net profit by calendar day (UTC)
  const dailyMap = new Map<string, Decimal>()

  for (const r of records) {
    if (!r.dateSettled || r.grossProfit === null) continue

    const key   = r.dateSettled.toISOString().slice(0, 10) // 'YYYY-MM-DD'
    const net   = D(r.grossProfit)
    const prev  = dailyMap.get(key) ?? D(0)
    dailyMap.set(key, prev.plus(net))
  }

  // Build sorted cumulative series
  const sortedKeys = Array.from(dailyMap.keys()).sort()
  let cumulative   = D(0)
  const result: ProfitPoint[] = []

  for (const key of sortedKeys) {
    const daily = dailyMap.get(key) ?? D(0)
    cumulative  = cumulative.plus(daily).toDecimalPlaces(2)

    const parts = key.split('-')
    const label = `${parts[2] ?? '??'}/${parts[1] ?? '??'}`

    result.push({
      date:        label,
      dailyProfit: daily.toDecimalPlaces(2).toNumber(),
      cumulative:  cumulative.toNumber(),
    })
  }

  return result
}
