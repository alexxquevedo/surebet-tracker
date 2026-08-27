import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'

export const metadata: Metadata = { title: 'Scanner — DualStats Tracker' }

const SPORT_LABELS: Record<string, string> = {
  FOOTBALL:   'Fútbol',
  TENNIS:     'Tenis',
  BASKETBALL: 'Baloncesto',
  BASEBALL:   'Béisbol',
  HOCKEY:     'Hockey',
  CRICKET:    'Cricket',
  RUGBY:      'Rugby',
  GOLF:       'Golf',
  MMA:        'MMA',
  BOXING:     'Boxeo',
  CYCLING:    'Ciclismo',
  MOTORSPORT: 'Motor',
  ESPORTS:    'Esports',
  OTHER:      'Otros',
}

function timeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const mins   = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'ahora mismo'
  if (mins < 60) return `hace ${mins} min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `hace ${hrs}h`
  return `hace ${Math.floor(hrs / 24)}d`
}

export default async function ScannerPage() {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) redirect('/login')

  // Fetch last 200 detected arbs sorted newest first
  const arbs = await prisma.detectedArb.findMany({
    include: { legs: { orderBy: { odds: 'desc' } } },
    orderBy: { detectedAt: 'desc' },
    take:    200,
  })

  // Aggregate stats for the banner
  const last24h = new Date(Date.now() - 24 * 60 * 60_000)
  const recent  = arbs.filter((a) => a.detectedAt >= last24h)
  const liveCnt = recent.filter((a) => a.isLive).length
  const avgProfit =
    recent.length > 0
      ? recent.reduce((s, a) => s + a.profitPct, 0) / recent.length
      : null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Scanner</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Últimas oportunidades de arbitraje detectadas por FidesBot
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground shrink-0">
          <p>{arbs.length} oportunidades</p>
          <p>{recent.length} en las últimas 24h</p>
        </div>
      </div>

      {/* Stats banner */}
      {recent.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard label="Últimas 24h" value={String(recent.length)} unit="ops." />
          <StatCard label="En vivo (24h)" value={String(liveCnt)} unit="ops." />
          {avgProfit !== null && (
            <StatCard
              label="Margen medio"
              value={`+${avgProfit.toFixed(2)}%`}
              valueGreen
            />
          )}
        </div>
      )}

      {/* Arb list */}
      {arbs.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <p className="font-medium text-muted-foreground">Sin datos del scanner todavía</p>
          <p className="text-sm text-muted-foreground mt-1">
            FidesBot publicará aquí las oportunidades detectadas en tiempo real.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
          <div className="divide-y">
            {arbs.map((arb) => (
              <div key={arb.id} className="px-4 py-3.5 hover:bg-muted/20 transition-colors">
                <div className="flex items-start gap-3">
                  {/* Badges */}
                  <div className="flex flex-col gap-1 shrink-0 pt-0.5">
                    <span
                      className={`inline-block text-[10px] font-bold rounded-full px-2 py-0.5 ${
                        arb.type === 'SUREBET'
                          ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                          : 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
                      }`}
                    >
                      {arb.type === 'SUREBET' ? 'SUREBET' : 'MIDDLE'}
                    </span>
                    {arb.isLive && (
                      <span className="inline-block text-[10px] font-bold rounded-full px-2 py-0.5 bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                        LIVE
                      </span>
                    )}
                  </div>

                  {/* Main info */}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-snug truncate">{arb.eventName}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {SPORT_LABELS[arb.sport] ?? arb.sport} · {arb.market}
                    </p>

                    {/* Legs */}
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {arb.legs.map((leg) => (
                        <span
                          key={leg.id}
                          className="inline-flex items-center gap-1 text-[11px] rounded-md bg-muted px-2 py-0.5"
                        >
                          <span className="font-medium">{leg.bookmaker}</span>
                          <span className="text-muted-foreground">·</span>
                          <span className="tabular-nums">{leg.odds.toFixed(2)}</span>
                          {leg.selection && (
                            <>
                              <span className="text-muted-foreground">·</span>
                              <span className="truncate max-w-[80px]">{leg.selection}</span>
                            </>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Profit + time */}
                  <div className="text-right shrink-0">
                    <p className="text-base font-bold text-green-600 tabular-nums">
                      +{arb.profitPct.toFixed(2)}%
                    </p>
                    {arb.type === 'MIDDLE' && arb.worstLoss !== null && (
                      <p className="text-xs text-muted-foreground tabular-nums">
                        min {arb.worstLoss.toFixed(2)}%
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {timeAgo(arb.detectedAt)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  unit,
  valueGreen,
}: {
  label: string
  value: string
  unit?: string
  valueGreen?: boolean
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-1.5 tabular-nums ${valueGreen ? 'text-green-600' : ''}`}>
        {value}
        {unit && <span className="text-sm font-normal text-muted-foreground ml-1">{unit}</span>}
      </p>
    </div>
  )
}
