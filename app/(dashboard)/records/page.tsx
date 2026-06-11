import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { type Prisma } from '@prisma/client'
import { RecordsFilters }     from './_components/records-filters'
import { RecordsSection }     from './_components/records-section'
import type { SerializedRecord } from './_components/records-section'
import { PendientesSection }  from './_components/pendientes-section'
import type { DraftBet }      from './_components/pendientes-section'

export const metadata: Metadata = { title: 'Operaciones — DualStats Tracker' }

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

  // Build where clause — DRAFTs siempre excluidos (se muestran en su propia sección)
  const where: Prisma.BetRecordWhereInput = {
    userId,
    deletedAt: null,
    status: filterStatus
      ? filterStatus as Prisma.EnumBetStatusFilter['equals']
      : { not: 'DRAFT' as const },
    ...(filterSport  ? { sport: filterSport as Prisma.EnumSportTypeNullableFilter['equals'] } : {}),
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

  const userTz = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } })
  const tz = userTz?.timezone ?? 'Europe/Madrid'

  const [records, bookmakers, bankrolls, totalBetCount, draftRecords] = await Promise.all([
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
        notes: true,
        competition: true,
        eventName: true,
        isApproximate: true,
        totalStake: true,
        grossProfit: true,
        potentialReturn: true,
        datePlaced: true,
        eventDate: true,
        dateSettled: true,
        title: true,
        primaryBookmakerId: true,
        primaryBookmaker: { select: { name: true, etiqueta: true, color: true } },
        singleBetDetail:  { select: { selection: true, odds: true } },
        arbitrageDetail:  { select: { winningLegId: true } },
        middleDetail:     { select: { winningLegId: true, middleHit: true } },
        legs: {
          where: { deletedAt: null },
          orderBy: { id: 'asc' },
          select: { id: true, bookmakerId: true, stake: true, odds: true, potentialReturn: true, bookmaker: { select: { name: true, etiqueta: true } } },
        },
        bankrollId: true,
        bankroll: { select: { id: true, name: true, color: true } },
      },
    }),
    prisma.bookmaker.findMany({
      where: { userId },
      select: { id: true, name: true, etiqueta: true },
      orderBy: { name: 'asc' },
    }),
    prisma.bankroll.findMany({
      where: { userId, isActive: true },
      select: { id: true, name: true, color: true },
      orderBy: { name: 'asc' },
    }),
    userPlan === 'FREE'
      ? prisma.betRecord.count({ where: { userId, deletedAt: null } })
      : Promise.resolve(null),
    prisma.betRecord.findMany({
      where:   { userId, status: 'DRAFT', deletedAt: null },
      orderBy: { datePlaced: 'desc' },
      select: {
        id: true, type: true, sport: true, title: true, totalStake: true, datePlaced: true,
        legs: {
          where:   { deletedAt: null },
          orderBy: { id: 'asc' },
          select: {
            id: true, stake: true, odds: true,
            bookmaker: { select: { id: true, name: true, etiqueta: true, initialCapital: true } },
          },
        },
      },
    }),
  ])

  // ─── Serializar registros (Decimal → number, Date → ISO) ─────────────────
  const serializedRecords: SerializedRecord[] = records.map((r) => ({
    id:                 r.id,
    type:               r.type,
    status:             r.status,
    sport:              r.sport,
    isLive:             r.isLive,
    notes:              r.notes,
    competition:        r.competition,
    eventName:          r.eventName,
    totalStake:         parseFloat(r.totalStake.toString()),
    grossProfit:        r.grossProfit !== null ? parseFloat(r.grossProfit.toString()) : null,
    potentialReturn:    r.potentialReturn !== null ? parseFloat(r.potentialReturn.toString()) : null,
    datePlaced:         r.datePlaced.toISOString(),
    eventDate:          r.eventDate ? r.eventDate.toISOString() : null,
    dateSettled:        r.dateSettled ? r.dateSettled.toISOString() : null,
    title:              r.title,
    primaryBookmakerId: r.primaryBookmakerId,
    primaryBookmaker:   r.primaryBookmaker ?? null,
    singleBetDetail:    r.singleBetDetail
      ? { selection: r.singleBetDetail.selection, odds: r.singleBetDetail.odds ? parseFloat(r.singleBetDetail.odds.toString()) : null }
      : null,
    arbitrageDetail:    r.arbitrageDetail ?? null,
    middleDetail:       r.middleDetail ?? null,
    legs:               r.legs.map((l) => ({
      id:              l.id,
      bookmakerId:     l.bookmakerId,
      stake:           parseFloat(l.stake.toString()),
      odds:            parseFloat(l.odds.toString()),
      potentialReturn: parseFloat(l.potentialReturn.toString()),
      bookmaker:       l.bookmaker,
    })),
    bankrollId:         r.bankrollId,
    bankroll:           r.bankroll ?? null,
    isApproximate:      r.isApproximate,
  }))

  const totalPlaced = records.filter((r) => r.status === 'PLACED').length
  const totalPnl    = records.reduce((acc, r) => acc + (r.grossProfit ? parseFloat(r.grossProfit.toString()) : 0), 0)

  // ─── Serializar DRAFTs ────────────────────────────────────────────────────
  const serializedDrafts: DraftBet[] = draftRecords.map((d) => ({
    id:         d.id,
    type:       d.type,
    sport:      d.sport,
    title:      d.title,
    totalStake: parseFloat(d.totalStake.toString()),
    datePlaced: d.datePlaced.toISOString(),
    legs: d.legs.map((l) => ({
      id:    l.id,
      stake: parseFloat(l.stake.toString()),
      odds:  parseFloat(l.odds.toString()),
      bookmaker: {
        id:             l.bookmaker.id,
        name:           l.bookmaker.name,
        etiqueta:       l.bookmaker.etiqueta,
        initialCapital: l.bookmaker.initialCapital !== null ? parseFloat(l.bookmaker.initialCapital.toString()) : null,
      },
    })),
  }))

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

      {/* ─── Pendientes (DRAFTs del bot) ────────────────────────────────── */}
      {serializedDrafts.length > 0 && (
        <PendientesSection drafts={serializedDrafts} />
      )}

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

      {/* ─── Registros ──────────────────────────────────────────────────── */}
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

      <RecordsSection
        records={serializedRecords}
        bankrolls={bankrolls}
        tz={tz}
        filterSort={filterSort}
        filterParams={{
          ...(filterFrom   ? { dateFrom: filterFrom   } : {}),
          ...(filterTo     ? { dateTo:   filterTo     } : {}),
          ...(filterSport  ? { sport:    filterSport  } : {}),
          ...(filterBm     ? { bm:       filterBm     } : {}),
          ...(filterStatus ? { status:   filterStatus } : {}),
          ...(filterLive   ? { live:     filterLive   } : {}),
        }}
      />
    </div>
  )
}
