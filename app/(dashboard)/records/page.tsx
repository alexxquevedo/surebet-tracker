import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { type Prisma } from '@prisma/client'
import { SettleButton } from './_components/settle-button'
import type { LegInfo } from './_components/settle-button'
import { RecordsFilters } from './_components/records-filters'

export const metadata: Metadata = { title: 'Operaciones — DualStats Tracker' }

// ─── Labels ──────────────────────────────────────────────────────────────────

const BET_TYPE_LABEL: Record<string, string> = {
  ARBITRAGE: '⚡ Surebets',
  MIDDLE:    '🎯 Middlebet',
  SINGLE:    '⚽ Single',
  COMBO:     '📋 Combo',
  CASINO:    '🎰 Casino',
  CUSTOM:    '📝 Custom',
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  PLACED:      { label: 'En juego',  cls: 'bg-amber-100 text-amber-700 border border-amber-200'  },
  WON:         { label: 'Ganada',    cls: 'bg-green-100 text-green-700 border border-green-200'  },
  LOST:        { label: 'Perdida',   cls: 'bg-red-100 text-red-700 border border-red-200'        },
  VOID:        { label: 'Anulada',   cls: 'bg-gray-100 text-gray-600 border border-gray-200'     },
  CASHOUT:     { label: 'Cashout',   cls: 'bg-blue-100 text-blue-700 border border-blue-200'     },
  PARTIAL_WIN: { label: 'Parcial',   cls: 'bg-teal-100 text-teal-700 border border-teal-200'     },
}

const SPORT_LABEL: Record<string, string> = {
  FOOTBALL:   '⚽ Fútbol',
  BASKETBALL: '🏀 Baloncesto',
  TENNIS:     '🎾 Tenis',
  HOCKEY:     '🏒 Hockey Hielo',
  BASEBALL:   '⚾ Béisbol',
  RUGBY:      '🏉 Rugby',
  CRICKET:    '🏏 Cricket',
  GOLF:       '⛳ Golf',
  MMA:        '🥋 MMA',
  BOXING:     '🥊 Boxeo',
  MOTORSPORT: '🏎️ Motorsport',
  ESPORTS:    '🎮 eSports',
  OTHER:      '🎯 Otro',
}

// ─── Date preset helpers ──────────────────────────────────────────────────────

function getDatePresets() {
  const now  = new Date()
  const pad  = (n: number) => String(n).padStart(2, '0')
  const iso  = (d: Date)   => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const today = iso(now)

  // Start of this week (Monday)
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7))

  // Start of this month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  // Last month
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0)

  return {
    today:         { from: today,             to: today },
    thisWeek:      { from: iso(weekStart),    to: today },
    thisMonth:     { from: iso(monthStart),   to: today },
    lastMonth:     { from: iso(lastMonthStart), to: iso(lastMonthEnd) },
  }
}

function buildPresetUrl(base: string, from: string, to: string, extra: string) {
  return `${base}?dateFrom=${from}&dateTo=${to}${extra}`
}

function buildSortUrl(
  key: string,
  current: string,
  filters: { sport?: string; bm?: string; status?: string; live?: string; dateFrom?: string; dateTo?: string },
): string {
  const next = current === `${key}-desc` ? `${key}-asc` : `${key}-desc`
  const p    = new URLSearchParams()
  if (filters.dateFrom) p.set('dateFrom', filters.dateFrom)
  if (filters.dateTo)   p.set('dateTo',   filters.dateTo)
  if (filters.sport)    p.set('sport',    filters.sport)
  if (filters.bm)       p.set('bm',       filters.bm)
  if (filters.status)   p.set('status',   filters.status)
  if (filters.live)     p.set('live',     filters.live)
  p.set('sort', next)
  return `/records?${p.toString()}`
}

function SortIcon({ col, current }: { col: string; current: string }) {
  if (current === `${col}-desc`) return <span className="ml-1 opacity-70">↓</span>
  if (current === `${col}-asc`)  return <span className="ml-1 opacity-70">↑</span>
  return <span className="ml-1 opacity-30">↕</span>
}

// ─── Page ────────────────────────────────────────────────────────────────────

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function RecordsPage({ searchParams }: PageProps) {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) redirect('/login')

  const params       = await searchParams
  const filterSport  = typeof params['sport']    === 'string' ? params['sport']    : undefined
  const filterBm     = typeof params['bm']       === 'string' ? params['bm']       : undefined
  const filterStatus = typeof params['status']   === 'string' ? params['status']   : undefined
  const filterLive   = typeof params['live']     === 'string' ? params['live']     : undefined
  const filterFrom   = typeof params['dateFrom'] === 'string' ? params['dateFrom'] : undefined
  const filterTo     = typeof params['dateTo']   === 'string' ? params['dateTo']   : undefined
  const filterSort   = typeof params['sort']     === 'string' ? params['sort']     : 'date-desc'

  // Build where clause
  const where: Prisma.BetRecordWhereInput = {
    userId,
    deletedAt: null,
    ...(filterSport  ? { sport:  filterSport  as Prisma.EnumSportTypeNullableFilter['equals'] } : {}),
    ...(filterStatus ? { status: filterStatus as Prisma.EnumBetStatusFilter['equals'] } : {}),
    ...(filterLive === 'true'  ? { isLive: true  } : {}),
    ...(filterLive === 'false' ? { isLive: false } : {}),
    ...(filterBm ? {
      OR: [
        { primaryBookmakerId: filterBm },
        { legs: { some: { bookmakerId: filterBm } } },
      ],
    } : {}),
    ...(filterFrom || filterTo ? {
      datePlaced: {
        ...(filterFrom ? { gte: new Date(`${filterFrom}T00:00:00`) } : {}),
        ...(filterTo   ? { lte: new Date(`${filterTo}T23:59:59`)   } : {}),
      },
    } : {}),
  }

  const orderBy: Prisma.BetRecordOrderByWithRelationInput[] =
    filterSort === 'date-asc'    ? [{ datePlaced: 'asc' }] :
    filterSort === 'stake-desc'  ? [{ totalStake: 'desc' }, { datePlaced: 'desc' }] :
    filterSort === 'stake-asc'   ? [{ totalStake: 'asc'  }, { datePlaced: 'desc' }] :
    filterSort === 'profit-desc' ? [{ grossProfit: { sort: 'desc', nulls: 'last' } }, { datePlaced: 'desc' }] :
    filterSort === 'profit-asc'  ? [{ grossProfit: { sort: 'asc',  nulls: 'last' } }, { datePlaced: 'desc' }] :
                                   [{ datePlaced: 'desc' }]

  const userPlan = (session?.user as { plan?: string })?.plan ?? 'FREE'
  const FREE_BET_LIMIT = 50

  const [records, bookmakers, totalBetCount] = await Promise.all([
    prisma.betRecord.findMany({
      where,
      orderBy,
      take: 100,
      select: {
        id: true,
        type: true,
        status: true,
        sport: true,
        isLive: true,
        totalStake: true,
        grossProfit: true,
        potentialReturn: true,
        datePlaced: true,
        dateSettled: true,
        title: true,
        primaryBookmakerId: true,
        primaryBookmaker: { select: { name: true, color: true } },
        singleBetDetail:  { select: { selection: true, odds: true } },
        legs: {
          where: { deletedAt: null },
          orderBy: { id: 'asc' },
          select: { id: true, bookmakerId: true, stake: true, odds: true, potentialReturn: true, bookmaker: { select: { name: true } } },
        },
      },
    }),
    prisma.bookmaker.findMany({
      where: { userId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    userPlan === 'FREE'
      ? prisma.betRecord.count({ where: { userId, deletedAt: null } })
      : Promise.resolve(null),
  ])

  const totalPlaced = records.filter((r) => r.status === 'PLACED').length
  const totalPnl    = records.reduce((acc, r) => acc + (r.grossProfit ? parseFloat(r.grossProfit.toString()) : 0), 0)

  // ─── Build date preset URLs ───────────────────────────────────────────────
  const presets    = getDatePresets()
  const extraParams = [
    filterSport  ? `&sport=${filterSport}`   : '',
    filterBm     ? `&bm=${filterBm}`         : '',
    filterStatus ? `&status=${filterStatus}` : '',
    filterLive   ? `&live=${filterLive}`     : '',
  ].join('')

  return (
    <div className="space-y-6">

      {/* Header */}
      {(() => {
        const csvParams = new URLSearchParams()
        if (filterFrom)   csvParams.set('dateFrom', filterFrom)
        if (filterTo)     csvParams.set('dateTo',   filterTo)
        if (filterSport)  csvParams.set('sport',    filterSport)
        if (filterBm)     csvParams.set('bm',       filterBm)
        if (filterStatus) csvParams.set('status',   filterStatus)
        if (filterLive)   csvParams.set('live',     filterLive)
        return (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Operaciones</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {records.length} registros · {totalPlaced} en juego ·{' '}
                <span className={totalPnl >= 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                  {totalPnl >= 0 ? '+' : ''}{totalPnl.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })} P&L
                </span>
              </p>
            </div>
            <a
              href={`/api/records/export?${csvParams.toString()}`}
              className="shrink-0 flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              📥 Exportar CSV
            </a>
          </div>
        )
      })()}

      {/* ─── Banner límite FREE ─────────────────────────────────────────── */}
      {userPlan === 'FREE' && totalBetCount !== null && (
        <div className={`rounded-xl border px-4 py-3 flex items-center justify-between gap-3 text-sm ${
          totalBetCount >= FREE_BET_LIMIT
            ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
            : totalBetCount >= FREE_BET_LIMIT * 0.8
              ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300'
              : 'bg-muted/40 border-border text-muted-foreground'
        }`}>
          <div className="flex items-center gap-2">
            <span>{totalBetCount >= FREE_BET_LIMIT ? '🔒' : '📊'}</span>
            <span>
              {totalBetCount >= FREE_BET_LIMIT
                ? 'Has alcanzado el límite de 50 operaciones del plan FREE.'
                : `${totalBetCount} / ${FREE_BET_LIMIT} operaciones registradas (plan FREE)`}
            </span>
          </div>
          <a href="/settings" className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline">
            Actualizar a PRO →
          </a>
        </div>
      )}

      {/* ─── Date Range Presets ─────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Período</p>
        <div className="flex flex-wrap gap-2">
          {[
            { label: 'Hoy',         ...presets.today,      },
            { label: 'Esta semana', ...presets.thisWeek,   },
            { label: 'Este mes',    ...presets.thisMonth,  },
            { label: 'Mes pasado',  ...presets.lastMonth,  },
          ].map(({ label, from, to }) => {
            const isActive  = filterFrom === from && filterTo === to
            // Si ya está activo, al pulsar de nuevo lo desactiva (mantiene el resto de filtros)
            const clearUrl  = extraParams ? `/records?${extraParams.slice(1)}` : '/records'
            const applyUrl  = buildPresetUrl('/records', from, to, extraParams)
            const href      = isActive ? clearUrl : applyUrl
            return (
              <a
                key={label}
                href={href}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  isActive
                    ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                    : 'bg-background text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                {label}
              </a>
            )
          })}

          {/* Custom range */}
          <form method="GET" className="flex items-center gap-2">
            {filterSport  && <input type="hidden" name="sport"  value={filterSport}  />}
            {filterBm     && <input type="hidden" name="bm"     value={filterBm}     />}
            {filterStatus && <input type="hidden" name="status" value={filterStatus} />}
            {filterLive   && <input type="hidden" name="live"   value={filterLive}   />}
            <input
              type="date"
              name="dateFrom"
              defaultValue={filterFrom ?? ''}
              className="rounded-lg border bg-background px-2.5 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
            <span className="text-xs text-muted-foreground">→</span>
            <input
              type="date"
              name="dateTo"
              defaultValue={filterTo ?? ''}
              className="rounded-lg border bg-background px-2.5 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="submit"
              className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              Aplicar
            </button>
          </form>
        </div>
      </div>

      {/* ─── Filters (auto-apply con debounce 300ms) ────────────────────── */}
      <RecordsFilters
        bookmakers={bookmakers}
        filterSport={filterSport}
        filterBm={filterBm}
        filterStatus={filterStatus}
        filterLive={filterLive}
        filterFrom={filterFrom}
        filterTo={filterTo}
      />

      {/* ─── Table ──────────────────────────────────────────────────────── */}
      {records.length === 0 && (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <p className="text-3xl mb-3">📋</p>
          <p className="font-semibold">Sin operaciones</p>
          <p className="text-sm text-muted-foreground mt-1">
            {(filterSport ?? filterBm ?? filterStatus ?? filterLive ?? filterFrom ?? filterTo)
              ? 'No hay operaciones que coincidan con los filtros actuales.'
              : 'Usa el botón + para registrar tu primera apuesta.'}
          </p>
        </div>
      )}

      {/* ─── Tabla (escritorio) ─────────────────────────────────────────── */}
      {records.length > 0 && (
        <div className="hidden md:block rounded-xl border shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Tipo</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden md:table-cell">Selección</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden lg:table-cell">Casa</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Estado</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                  <a href={buildSortUrl('stake', filterSort, { sport: filterSport, bm: filterBm, status: filterStatus, live: filterLive, dateFrom: filterFrom, dateTo: filterTo })} className="hover:text-foreground transition-colors">
                    Stake<SortIcon col="stake" current={filterSort} />
                  </a>
                </th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                  <a href={buildSortUrl('profit', filterSort, { sport: filterSport, bm: filterBm, status: filterStatus, live: filterLive, dateFrom: filterFrom, dateTo: filterTo })} className="hover:text-foreground transition-colors">
                    P&L<SortIcon col="profit" current={filterSort} />
                  </a>
                </th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden sm:table-cell">
                  <a href={buildSortUrl('date', filterSort, { sport: filterSport, bm: filterBm, status: filterStatus, live: filterLive, dateFrom: filterFrom, dateTo: filterTo })} className="hover:text-foreground transition-colors">
                    Fecha<SortIcon col="date" current={filterSort} />
                  </a>
                </th>
                <th className="px-4 py-3 text-xs uppercase tracking-wide"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {records.map((r) => {
                const profit    = r.grossProfit !== null ? parseFloat(r.grossProfit.toString()) : null
                const profitCls = profit === null
                  ? 'text-muted-foreground'
                  : profit > 0 ? 'text-green-600 font-semibold' : profit < 0 ? 'text-red-600 font-semibold' : 'text-muted-foreground'

                const selText    = r.title ?? r.singleBetDetail?.selection ?? '—'
                const legNames   = r.legs.map((l) => l.bookmaker.name).join(' + ')
                const houseLabel = r.legs.length > 0
                  ? legNames
                  : r.primaryBookmaker?.name ?? '—'

                const sm      = STATUS_META[r.status] ?? { label: r.status, cls: 'bg-gray-100 text-gray-600 border border-gray-200' }
                const dateObj = new Date(r.datePlaced)
                const dateFmt = dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
                const timeFmt = dateObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })

                // Build bet info for settle modal
                const betForSettle = {
                  id:                 r.id,
                  type:               r.type,
                  totalStake:         parseFloat(r.totalStake.toString()),
                  primaryBookmakerId: r.primaryBookmakerId,
                  singleOdds:         r.singleBetDetail?.odds ? parseFloat(r.singleBetDetail.odds.toString()) : null,
                  legs:               r.legs.map((l): LegInfo => ({
                    id:              l.id,
                    bookmakerId:     l.bookmakerId,
                    bookmakerName:   l.bookmaker.name,
                    stake:           parseFloat(l.stake.toString()),
                    odds:            parseFloat(l.odds.toString()),
                    potentialReturn: parseFloat(l.potentialReturn.toString()),
                  })),
                }

                return (
                  <tr key={r.id} className="hover:bg-muted/20 transition-colors group">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {r.isLive && (
                          <span className="text-xs font-bold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full leading-tight">
                            LIVE
                          </span>
                        )}
                        <span className="text-xs font-semibold">{BET_TYPE_LABEL[r.type] ?? r.type}</span>
                      </div>
                      {r.sport && (
                        <p className="text-xs text-muted-foreground mt-0.5">{SPORT_LABEL[r.sport] ?? r.sport}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell max-w-[180px]">
                      <span className="text-xs text-muted-foreground truncate block">{selText}</span>
                      {r.singleBetDetail?.odds && (
                        <span className="text-xs font-mono text-muted-foreground">
                          @{parseFloat(r.singleBetDetail.odds.toString()).toFixed(2)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <div className="flex items-center gap-1.5">
                        {r.primaryBookmaker?.color && r.legs.length === 0 && (
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.primaryBookmaker.color }} />
                        )}
                        <span className="text-xs">{houseLabel}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center text-xs font-semibold rounded-full px-2.5 py-0.5 ${sm.cls}`}>
                        {sm.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {parseFloat(r.totalStake.toString()).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-xs ${profitCls}`}>
                      {profit === null
                        ? <span className="text-muted-foreground">{parseFloat((r.potentialReturn ?? r.totalStake).toString()).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}</span>
                        : `${profit >= 0 ? '+' : ''}${profit.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`
                      }
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground hidden sm:table-cell">
                      <span className="block">{dateFmt}</span>
                      <span className="block text-muted-foreground/60">{timeFmt}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.status === 'PLACED' && (
                        <SettleButton bet={betForSettle} />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Tarjetas (móvil) ───────────────────────────────────────────── */}
      {records.length > 0 && (
        <div className="block md:hidden space-y-3">
          {records.map((r) => {
            const profit    = r.grossProfit !== null ? parseFloat(r.grossProfit.toString()) : null
            const pnlCls    =
              profit === null
                ? 'text-muted-foreground'
                : profit > 0
                  ? 'text-green-600 font-bold'
                  : profit < 0
                    ? 'text-red-600 font-bold'
                    : 'text-muted-foreground'
            const selText    = r.title ?? r.singleBetDetail?.selection ?? '—'
            const legNames   = r.legs.map((l) => l.bookmaker.name).join(' + ')
            const houseLabel = r.legs.length > 0 ? legNames : (r.primaryBookmaker?.name ?? '—')
            const sm         = STATUS_META[r.status] ?? { label: r.status, cls: 'bg-gray-100 text-gray-600 border border-gray-200' }
            const dateObj    = new Date(r.datePlaced)
            const dateFmt    = dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
            const timeFmt    = dateObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })

            const betForSettle = {
              id:                 r.id,
              type:               r.type,
              totalStake:         parseFloat(r.totalStake.toString()),
              primaryBookmakerId: r.primaryBookmakerId,
              singleOdds:         r.singleBetDetail?.odds
                ? parseFloat(r.singleBetDetail.odds.toString())
                : null,
              legs: r.legs.map((l): LegInfo => ({
                id:              l.id,
                bookmakerId:     l.bookmakerId,
                bookmakerName:   l.bookmaker.name,
                stake:           parseFloat(l.stake.toString()),
                odds:            parseFloat(l.odds.toString()),
                potentialReturn: parseFloat(l.potentialReturn.toString()),
              })),
            }

            return (
              <div key={r.id} className="rounded-xl border bg-card shadow-sm overflow-hidden">

                {/* ── Cabecera: tipo · evento · estado badge ─────────── */}
                <div className="flex items-start justify-between gap-3 px-4 py-3 border-b bg-muted/20 min-h-[44px]">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {r.isLive && (
                      <span className="shrink-0 text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full leading-tight">
                        LIVE
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold leading-tight truncate">{selText}</p>
                      <p className="text-xs text-muted-foreground">{BET_TYPE_LABEL[r.type] ?? r.type}</p>
                    </div>
                  </div>
                  <span className={`shrink-0 inline-flex items-center text-xs font-semibold rounded-full px-2.5 py-1 ${sm.cls}`}>
                    {sm.label}
                  </span>
                </div>

                {/* ── Cuerpo: casa · stake · cuota · P&L ────────────── */}
                <div className="flex items-center justify-between gap-3 px-4 py-3 min-h-[44px]">
                  <div className="min-w-0 space-y-0.5 flex-1">
                    <p className="text-xs font-medium text-foreground truncate">{houseLabel}</p>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
                      <span className="font-mono">
                        {parseFloat(r.totalStake.toString()).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                      </span>
                      {r.singleBetDetail?.odds && (
                        <>
                          <span>·</span>
                          <span className="font-mono">
                            @{parseFloat(r.singleBetDetail.odds.toString()).toFixed(2)}
                          </span>
                        </>
                      )}
                      {r.sport && (
                        <>
                          <span>·</span>
                          <span>{SPORT_LABEL[r.sport] ?? r.sport}</span>
                        </>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground/70">{dateFmt} · {timeFmt}</p>
                  </div>

                  {/* P&L / retorno potencial */}
                  <div className="shrink-0 text-right">
                    <p className={`text-base tabular-nums ${pnlCls}`}>
                      {profit === null
                        ? parseFloat(
                            (r.potentialReturn ?? r.totalStake).toString(),
                          ).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })
                        : `${profit >= 0 ? '+' : ''}${profit.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`
                      }
                    </p>
                    {profit === null && (
                      <p className="text-[10px] text-muted-foreground">Potencial</p>
                    )}
                  </div>
                </div>

                {/* ── Pie: botón liquidar (solo PLACED) ─────────────── */}
                {r.status === 'PLACED' && (
                  <div className="px-4 pb-3 border-t pt-2 bg-muted/10">
                    <SettleButton bet={betForSettle} />
                  </div>
                )}

              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
