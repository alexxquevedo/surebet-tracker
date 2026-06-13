import { prisma } from '@/lib/db/client'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DistributionItem {
  status: string
  label:  string
  count:  number
  color:  string
}

export interface CategoryStat {
  name:    string
  count:   number
  won:     number
  winRate: number
  profit:  number
}

export interface TypeStat {
  type:    string
  label:   string
  count:   number
  won:     number
  winRate: number
  profit:  number
  yield:   number
}

export interface MonthlyPnl {
  month:  string   // 'Ene 25'
  profit: number
  count:  number
}

export interface BestWorst {
  title:  string
  profit: number
}

export interface StatsData {
  totalSettled:   number
  totalAll:       number
  winRate:        number
  avgStake:       number
  totalProfit:    number
  totalRoi:       number
  distribution:   DistributionItem[]
  bySport:        CategoryStat[]
  byBookmaker:    CategoryStat[]
  byType:         TypeStat[]
  monthlyPnl:     MonthlyPnl[]
  bestWin:        BestWorst | null
  worstLoss:      BestWorst | null
  currentStreak:  { type: 'won' | 'lost'; count: number } | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  return arr.reduce<Record<string, T[]>>((acc, item) => {
    const k = key(item)
    ;(acc[k] ??= []).push(item)
    return acc
  }, {})
}

// ─── Query ───────────────────────────────────────────────────────────────────

const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

const TYPE_LABEL_MAP: Record<string, string> = {
  ARBITRAGE: 'Surebets',
  MIDDLE:    'Middlebet',
  SINGLE:    'Single',
  COMBO:     'Combo',
  CASINO:    'Casino',
  CUSTOM:    'Custom',
}

export async function getStatsData(userId: string, dateFrom?: Date): Promise<StatsData> {
  const records = await prisma.betRecord.findMany({
    where:   { userId, deletedAt: null, ...(dateFrom ? { datePlaced: { gte: dateFrom } } : {}) },
    orderBy: { datePlaced: 'desc' },
    select: {
      status:      true,
      type:        true,
      sport:       true,
      title:       true,
      datePlaced:  true,
      grossProfit: true,
      totalStake:  true,
      primaryBookmaker: { select: { name: true } },
      legs: {
        where:  { deletedAt: null },
        select: { bookmaker: { select: { name: true } } },
      },
    },
  })

  const settled = records.filter((r) => r.status !== 'PLACED')
  const won     = settled.filter((r) => r.status === 'WON' || r.status === 'PARTIAL_WIN')
  const nonVoid = settled.filter((r) => r.status !== 'VOID')

  const winRate     = nonVoid.length > 0 ? (won.length / nonVoid.length) * 100 : 0
  const totalProfit = settled.reduce((acc, r) => acc + (r.grossProfit ? parseFloat(r.grossProfit.toString()) : 0), 0)
  const avgStake    = records.length > 0
    ? records.reduce((acc, r) => acc + parseFloat(r.totalStake.toString()), 0) / records.length
    : 0

  // ROI total sobre stake de ops. liquidadas
  const settledStakeTotal = settled.reduce((acc, r) => acc + parseFloat(r.totalStake.toString()), 0)
  const totalRoi = settledStakeTotal > 0 ? (totalProfit / settledStakeTotal) * 100 : 0

  // ── Distribución ──────────────────────────────────────────────────────────
  const STATUS_META: Record<string, { label: string; color: string }> = {
    WON:         { label: 'Ganada',    color: '#16a34a' },
    PARTIAL_WIN: { label: 'Parcial',   color: '#0d9488' },
    LOST:        { label: 'Perdida',   color: '#dc2626' },
    VOID:        { label: 'Anulada',   color: '#9ca3af' },
    CASHOUT:     { label: 'Cashout',   color: '#2563eb' },
    PLACED:      { label: 'En juego',  color: '#d97706' },
  }

  const countsByStatus = groupBy(records, (r) => r.status)
  const distribution: DistributionItem[] = Object.entries(STATUS_META)
    .map(([status, meta]) => ({
      status,
      label: meta.label,
      count: countsByStatus[status]?.length ?? 0,
      color: meta.color,
    }))
    .filter((d) => d.count > 0)

  // ── Por deporte ───────────────────────────────────────────────────────────
  const SPORT_LABEL: Record<string, string> = {
    FOOTBALL:   'Fútbol',
    BASKETBALL: 'Baloncesto',
    TENNIS:     'Tenis',
    HOCKEY:     'Hockey',
    BASEBALL:   'Béisbol',
    RUGBY:      'Rugby',
    MMA:        'MMA',
    BOXING:     'Boxeo',
    MOTORSPORT: 'Motorsport',
    ESPORTS:    'eSports',
    OTHER:      'Otro',
  }

  const bySportGroup = groupBy(settled, (r) => r.sport ?? 'OTHER')
  const bySport: CategoryStat[] = Object.entries(bySportGroup)
    .filter(([, recs]) => recs.length >= 2)
    .map(([sport, recs]) => {
      const nv = recs.filter((r) => r.status !== 'VOID')
      const w  = recs.filter((r) => r.status === 'WON' || r.status === 'PARTIAL_WIN')
      return {
        name:    SPORT_LABEL[sport] ?? sport,
        count:   recs.length,
        won:     w.length,
        winRate: nv.length > 0 ? (w.length / nv.length) * 100 : 0,
        profit:  recs.reduce((acc, r) => acc + (r.grossProfit ? parseFloat(r.grossProfit.toString()) : 0), 0),
      }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  // ── Por casa (solo single, no surebets multi-leg) ─────────────────────────
  const singleSettled = settled.filter((r) => r.legs.length === 0 && r.primaryBookmaker)
  const byBmGroup = groupBy(singleSettled, (r) => r.primaryBookmaker!.name)
  const byBookmaker: CategoryStat[] = Object.entries(byBmGroup)
    .filter(([, recs]) => recs.length >= 2)
    .map(([name, recs]) => {
      const nv = recs.filter((r) => r.status !== 'VOID')
      const w  = recs.filter((r) => r.status === 'WON' || r.status === 'PARTIAL_WIN')
      return {
        name,
        count:   recs.length,
        won:     w.length,
        winRate: nv.length > 0 ? (w.length / nv.length) * 100 : 0,
        profit:  recs.reduce((acc, r) => acc + (r.grossProfit ? parseFloat(r.grossProfit.toString()) : 0), 0),
      }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  // ── Por tipo de apuesta ───────────────────────────────────────────────────
  const byTypeGroup = groupBy(settled, (r) => r.type)
  const byType: TypeStat[] = Object.entries(byTypeGroup)
    .map(([type, recs]) => {
      const nv     = recs.filter((r) => r.status !== 'VOID')
      const w      = recs.filter((r) => r.status === 'WON' || r.status === 'PARTIAL_WIN')
      const profit = recs.reduce((acc, r) => acc + (r.grossProfit ? parseFloat(r.grossProfit.toString()) : 0), 0)
      const stake  = recs.reduce((acc, r) => acc + parseFloat(r.totalStake.toString()), 0)
      return {
        type,
        label:   TYPE_LABEL_MAP[type] ?? type,
        count:   recs.length,
        won:     w.length,
        winRate: nv.length > 0 ? (w.length / nv.length) * 100 : 0,
        profit,
        yield:   stake > 0 ? (profit / stake) * 100 : 0,
      }
    })
    .sort((a, b) => b.count - a.count)

  // ── Evolución mensual P&L (últimos 12 meses) ─────────────────────────────
  const nowDate  = new Date()
  const monthKeys: string[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1)
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  const monthlyMap = new Map<string, { profit: number; count: number }>()
  monthKeys.forEach((k) => monthlyMap.set(k, { profit: 0, count: 0 }))

  for (const r of settled) {
    const d   = new Date(r.datePlaced)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const entry = monthlyMap.get(key)
    if (entry) {
      entry.profit += r.grossProfit ? parseFloat(r.grossProfit.toString()) : 0
      entry.count++
    }
  }

  const monthlyPnl: MonthlyPnl[] = monthKeys.map((key) => {
    const [year, month] = key.split('-')
    const idx = parseInt(month ?? '1') - 1
    const shortYear = String(year).slice(2)
    return {
      month:  `${MONTH_NAMES[idx]} ${shortYear}`,
      profit: monthlyMap.get(key)?.profit ?? 0,
      count:  monthlyMap.get(key)?.count  ?? 0,
    }
  })

  // ── Mejor / peor operación ────────────────────────────────────────────────
  const withProfit = settled.filter((r) => r.grossProfit !== null)
  let bestWin:   BestWorst | null = null
  let worstLoss: BestWorst | null = null

  if (withProfit.length > 0) {
    let bestR  = withProfit[0]!
    let worstR = withProfit[0]!
    for (const r of withProfit) {
      if (parseFloat(r.grossProfit!.toString()) > parseFloat(bestR.grossProfit!.toString()))  bestR  = r
      if (parseFloat(r.grossProfit!.toString()) < parseFloat(worstR.grossProfit!.toString())) worstR = r
    }
    bestWin   = { title: bestR.title  ?? 'Sin título', profit: parseFloat(bestR.grossProfit!.toString()) }
    worstLoss = { title: worstR.title ?? 'Sin título', profit: parseFloat(worstR.grossProfit!.toString()) }
  }

  // ── Racha actual ─────────────────────────────────────────────────────────
  // nonVoidSettled ordered most-recent-first (datePlaced desc — same as records)
  const nonVoidSettled = settled.filter((r) => r.status !== 'VOID')
  let currentStreak: { type: 'won' | 'lost'; count: number } | null = null

  if (nonVoidSettled.length > 0) {
    const isWin    = (r: typeof nonVoidSettled[0]) => r.status === 'WON' || r.status === 'PARTIAL_WIN'
    const firstWin = isWin(nonVoidSettled[0]!)
    let count = 0
    for (const r of nonVoidSettled) {
      if (isWin(r) === firstWin) count++
      else break
    }
    currentStreak = { type: firstWin ? 'won' : 'lost', count }
  }

  return {
    totalSettled: settled.length,
    totalAll:     records.length,
    winRate,
    avgStake,
    totalProfit,
    totalRoi,
    distribution,
    bySport,
    byBookmaker,
    byType,
    monthlyPnl,
    bestWin,
    worstLoss,
    currentStreak,
  }
}

// ─── Activity heatmap (últimos 365 días) ─────────────────────────────────────

export interface HeatmapDay {
  date:   string  // YYYY-MM-DD
  profit: number
  count:  number
}

export async function getActivityHeatmap(userId: string): Promise<HeatmapDay[]> {
  const from = new Date()
  from.setFullYear(from.getFullYear() - 1)

  const records = await prisma.betRecord.findMany({
    where: {
      userId,
      deletedAt: null,
      status:    { in: ['WON', 'LOST', 'CASHOUT', 'VOID'] },
      datePlaced: { gte: from },
    },
    select: { datePlaced: true, grossProfit: true },
  })

  const byDay = new Map<string, { profit: number; count: number }>()
  for (const r of records) {
    const key  = r.datePlaced.toISOString().slice(0, 10)
    const prev = byDay.get(key) ?? { profit: 0, count: 0 }
    byDay.set(key, {
      profit: prev.profit + (r.grossProfit ? parseFloat(r.grossProfit.toString()) : 0),
      count:  prev.count + 1,
    })
  }

  return [...byDay.entries()]
    .map(([date, v]) => ({ date, profit: v.profit, count: v.count }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
