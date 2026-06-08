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

export interface StatsData {
  totalSettled:   number
  totalAll:       number
  winRate:        number
  avgStake:       number
  totalProfit:    number
  distribution:   DistributionItem[]
  bySport:        CategoryStat[]
  byBookmaker:    CategoryStat[]
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

export async function getStatsData(userId: string): Promise<StatsData> {
  const records = await prisma.betRecord.findMany({
    where:   { userId, deletedAt: null },
    orderBy: { datePlaced: 'desc' },
    select: {
      status:    true,
      sport:     true,
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

  return {
    totalSettled: settled.length,
    totalAll:     records.length,
    winRate,
    avgStake,
    totalProfit,
    distribution,
    bySport,
    byBookmaker,
  }
}
