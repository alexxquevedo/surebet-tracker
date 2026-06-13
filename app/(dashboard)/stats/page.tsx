import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { getStatsData } from '@/lib/queries/stats'
import { getBankrollEvolution, getAdvancedStats } from '@/lib/queries/dashboard'
import type { AdvancedStats } from '@/types/domain'
import { AdvancedSection } from '@/app/(dashboard)/_components/advanced-section'
import { DistributionChart } from './_components/distribution-chart'
import { WinRateBars } from './_components/win-rate-bars'
import { MonthlyPnlChart } from './_components/monthly-pnl-chart'
import { BankrollEvolutionChart } from './_components/bankroll-evolution-chart'

export const metadata: Metadata = { title: 'Estadísticas — DualStats Tracker' }

// ─── Selector de período ──────────────────────────────────────────────────────

const PERIODS = [
  { label: 'Todo',     value: 'all' },
  { label: '7 días',   value: '7d'  },
  { label: 'Mes',      value: '30d' },
  { label: '3 meses',  value: '3m'  },
  { label: 'Año',      value: '1y'  },
] as const

const PERIOD_LABEL: Record<string, string> = {
  '7d':  'Últimos 7 días',
  '30d': 'Último mes',
  '3m':  'Últimos 3 meses',
  '1y':  'Último año',
}

function PeriodNav({ current }: { current: string }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {PERIODS.map((p) => (
        <a
          key={p.value}
          href={p.value === 'all' ? '/stats' : `/stats?period=${p.value}`}
          className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
            current === p.value
              ? 'bg-primary text-primary-foreground border-primary'
              : 'border-muted-foreground/20 text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
        >
          {p.label}
        </a>
      ))}
    </div>
  )
}

function profitCls(v: number) {
  if (v > 0) return 'text-green-600 dark:text-green-400'
  if (v < 0) return 'text-red-600 dark:text-red-400'
  return 'text-muted-foreground'
}

function fmtProfit(v: number) {
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`
}

// ─── Overlay de upgrade para FREE ────────────────────────────────────────────

function UpgradeOverlay() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl">
      {/* fondo translúcido */}
      <div className="absolute inset-0 bg-background/70 backdrop-blur-[2px] rounded-xl" />

      {/* tarjeta central */}
      <div className="relative z-10 mx-4 w-full max-w-sm rounded-2xl border bg-card shadow-2xl p-8 text-center space-y-5">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto text-3xl">
          📈
        </div>
        <div>
          <p className="text-lg font-bold">Desbloquea tus estadísticas</p>
          <p className="text-sm text-muted-foreground mt-1">
            Tus datos están aquí. Actualiza a PRO para verlos.
          </p>
        </div>
        <ul className="text-left space-y-2 text-sm">
          {[
            '📊 Distribución de resultados',
            '📈 Evolución mensual del P&L',
            '🏆 Win rate por deporte y estrategia',
            '🏦 Rendimiento por casa de apuestas',
            '💰 Análisis de P&L detallado',
          ].map((f) => (
            <li key={f} className="flex items-center gap-2 text-muted-foreground">
              <span className="text-primary">✓</span> {f}
            </li>
          ))}
        </ul>
        <a
          href="/settings"
          className="block w-full rounded-xl bg-primary text-primary-foreground px-6 py-3 text-sm font-bold hover:bg-primary/90 transition-colors shadow-lg"
        >
          Actualizar a PRO →
        </a>
      </div>
    </div>
  )
}

// ─── Contenido de estadísticas ────────────────────────────────────────────────

type CompRow = { name: string; count: number; won: number; winRate: number; profit: number; yield: number }

function StatsContent({
  stats,
  evolution,
  advanced,
  byCompetition,
  period,
  monthlyPnlOverride,
}: {
  stats: Awaited<ReturnType<typeof getStatsData>>
  evolution: Awaited<ReturnType<typeof getBankrollEvolution>>
  advanced: AdvancedStats
  byCompetition: CompRow[]
  period: string
  monthlyPnlOverride?: Awaited<ReturnType<typeof getStatsData>>['monthlyPnl'] | null
}) {
  const noData     = stats.totalAll === 0
  const hasPeriod  = period !== 'all'

  if (noData) {
    return (
      <div className="rounded-xl border border-dashed p-16 text-center">
        <p className="text-4xl mb-3">📈</p>
        <p className="font-semibold text-lg">
          {hasPeriod ? 'Sin operaciones en este período' : 'Sin datos todavía'}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          {hasPeriod
            ? 'Prueba con un período más amplio o registra nuevas operaciones.'
            : 'Registra y liquida apuestas para ver tus estadísticas aquí.'}
        </p>
      </div>
    )
  }

  const streak = stats.currentStreak

  return (
    <div className="space-y-6">

      {/* ── Evolución del bankroll ───────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-5 shadow-sm space-y-1">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Evolución del bankroll</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Saldo total a cierre de cada día · línea punteada = capital inicial
            </p>
          </div>
          {evolution.initialCapital > 0 && (
            <div className="text-right shrink-0">
              <p className="text-xs text-muted-foreground">Capital inicial</p>
              <p className="text-sm font-bold tabular-nums">
                {evolution.initialCapital.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
              </p>
            </div>
          )}
        </div>
        <BankrollEvolutionChart
          data={evolution.points}
          initialCapital={evolution.initialCapital}
        />
      </div>

      {/* ── KPI Row (6 tarjetas · 2 filas de 3) ─────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
        {/* Fila 1 */}
        <div className="rounded-xl border bg-card p-4 shadow-sm overflow-hidden">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Ops. liquidadas</p>
          <p className="text-2xl font-bold mt-2 tabular-nums">{stats.totalSettled}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">de {stats.totalAll} registradas</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm overflow-hidden">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Win Rate</p>
          <p className={`text-2xl font-bold mt-2 tabular-nums ${stats.winRate >= 50 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {stats.winRate.toFixed(1)}%
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">excluye anuladas</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm overflow-hidden">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Racha actual</p>
          {streak ? (
            <>
              <p className={`text-2xl font-bold mt-2 tabular-nums ${streak.type === 'won' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {streak.count}
              </p>
              <p className={`text-[10px] mt-0.5 font-medium ${streak.type === 'won' ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                {streak.type === 'won' ? '✅ victorias' : '❌ derrotas'}
              </p>
            </>
          ) : (
            <p className="text-2xl font-bold mt-2 text-muted-foreground">—</p>
          )}
        </div>
        {/* Fila 2 */}
        <div className="rounded-xl border bg-card p-4 shadow-sm overflow-hidden">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">P&L total</p>
          <p
            className={`text-xl font-bold mt-2 tabular-nums truncate ${profitCls(stats.totalProfit)}`}
            title={fmtProfit(stats.totalProfit)}
          >
            {fmtProfit(stats.totalProfit)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">beneficio neto</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm overflow-hidden">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">ROI</p>
          <p className={`text-xl font-bold mt-2 tabular-nums ${profitCls(stats.totalRoi)}`}>
            {stats.totalRoi > 0 ? '+' : ''}{stats.totalRoi.toFixed(2)}%
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">sobre stake liquidado</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm overflow-hidden">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Stake promedio</p>
          <p
            className="text-xl font-bold mt-2 tabular-nums truncate"
            title={stats.avgStake.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
          >
            {stats.avgStake.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">por operación</p>
        </div>
      </div>

      {/* ── Evolución mensual P&L ─────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-5 shadow-sm space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Evolución mensual del P&L</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Últimos 12 meses · Verde = beneficio · Rojo = pérdida
          </p>
        </div>
        <MonthlyPnlChart data={monthlyPnlOverride ?? stats.monthlyPnl} />
      </div>

      {/* ── Estadísticas Avanzadas ───────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-5 shadow-sm space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Estadísticas avanzadas</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Ventanas temporales · rachas · promedios · mejores y peores períodos
          </p>
        </div>
        <AdvancedSection advanced={advanced} />
      </div>

      {/* ── Distribución + Win rate por deporte ──────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-xl border bg-card p-5 shadow-sm space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Distribución de resultados</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {stats.totalSettled} operaciones liquidadas
            </p>
          </div>
          <DistributionChart data={stats.distribution} />
        </div>

        <div className="rounded-xl border bg-card p-5 shadow-sm space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Win rate por deporte</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Verde ≥ 55% · Naranja 45–55% · Rojo &lt; 45%
            </p>
          </div>
          <WinRateBars data={stats.bySport} label="deporte" />
        </div>
      </div>

      {/* ── P&L por estrategia ───────────────────────────────────────────── */}
      {stats.byType.length > 0 && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b bg-muted/30">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Rendimiento por estrategia
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[420px] sm:min-w-[560px]">
              <thead className="border-b bg-muted/20">
                <tr>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Estrategia</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ops.</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ganadas</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Win Rate</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">P&L</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Yield</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {stats.byType.map((row) => (
                  <tr key={row.type} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3.5 font-medium">{row.label}</td>
                    <td className="px-5 py-3.5 text-right tabular-nums text-muted-foreground">{row.count}</td>
                    <td className="px-5 py-3.5 text-right tabular-nums text-muted-foreground">{row.won}</td>
                    <td className={`px-5 py-3.5 text-right tabular-nums font-semibold ${row.winRate >= 55 ? 'text-green-600 dark:text-green-400' : row.winRate >= 45 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                      {row.winRate.toFixed(1)}%
                    </td>
                    <td className={`px-5 py-3.5 text-right tabular-nums font-semibold ${profitCls(row.profit)}`}>
                      {fmtProfit(row.profit)}
                    </td>
                    <td className={`px-5 py-3.5 text-right tabular-nums font-semibold ${profitCls(row.yield)}`}>
                      {row.yield > 0 ? '+' : ''}{row.yield.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Mejor / peor operación ───────────────────────────────────────── */}
      {(stats.bestWin || stats.worstLoss) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {stats.bestWin && (
            <div className="rounded-xl border bg-card p-5 shadow-sm space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">🏆 Mejor operación</p>
              <p
                className="text-xl font-bold tabular-nums text-green-600 dark:text-green-400 truncate"
                title={fmtProfit(stats.bestWin.profit)}
              >
                {fmtProfit(stats.bestWin.profit)}
              </p>
              <p className="text-xs text-muted-foreground truncate" title={stats.bestWin.title}>
                {stats.bestWin.title}
              </p>
            </div>
          )}
          {stats.worstLoss && (
            <div className="rounded-xl border bg-card p-5 shadow-sm space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">📉 Peor operación</p>
              <p
                className="text-xl font-bold tabular-nums text-red-600 dark:text-red-400 truncate"
                title={fmtProfit(stats.worstLoss.profit)}
              >
                {fmtProfit(stats.worstLoss.profit)}
              </p>
              <p className="text-xs text-muted-foreground truncate" title={stats.worstLoss.title}>
                {stats.worstLoss.title}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Win rate por casa ─────────────────────────────────────────────── */}
      {stats.byBookmaker.length > 0 && (
        <div className="rounded-xl border bg-card p-5 shadow-sm space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Win rate por casa de apuestas</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Solo apuestas single (excluye surebets multi-casa) · mín. 2 ops.
            </p>
          </div>
          <WinRateBars data={stats.byBookmaker} label="casa" />
        </div>
      )}

      {/* ── Tabla detallada por deporte ───────────────────────────────────── */}
      {stats.bySport.length > 0 && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b bg-muted/30">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Detalle por deporte
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[360px] sm:min-w-[480px]">
              <thead className="border-b bg-muted/20">
                <tr>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Deporte</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ops.</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ganadas</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Win Rate</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {stats.bySport.map((row) => (
                  <tr key={row.name} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3.5 font-medium">{row.name}</td>
                    <td className="px-5 py-3.5 text-right tabular-nums text-muted-foreground">{row.count}</td>
                    <td className="px-5 py-3.5 text-right tabular-nums text-muted-foreground">{row.won}</td>
                    <td className={`px-5 py-3.5 text-right tabular-nums font-semibold ${row.winRate >= 55 ? 'text-green-600 dark:text-green-400' : row.winRate >= 45 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                      {row.winRate.toFixed(1)}%
                    </td>
                    <td className={`px-5 py-3.5 text-right tabular-nums font-semibold ${profitCls(row.profit)}`}>
                      {fmtProfit(row.profit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Tabla por competición ─────────────────────────────────────────── */}
      {byCompetition.length > 0 && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b bg-muted/30">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Rendimiento por competición
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[420px] sm:min-w-[560px]">
              <thead className="border-b bg-muted/20">
                <tr>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Competición</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ops.</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ganadas</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Win Rate</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">P&L</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Yield</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {byCompetition.map((row) => (
                  <tr key={row.name} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3.5 font-medium">{row.name}</td>
                    <td className="px-5 py-3.5 text-right tabular-nums text-muted-foreground">{row.count}</td>
                    <td className="px-5 py-3.5 text-right tabular-nums text-muted-foreground">{row.won}</td>
                    <td className={`px-5 py-3.5 text-right tabular-nums font-semibold ${row.winRate >= 55 ? 'text-green-600 dark:text-green-400' : row.winRate >= 45 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                      {row.winRate.toFixed(1)}%
                    </td>
                    <td className={`px-5 py-3.5 text-right tabular-nums font-semibold ${profitCls(row.profit)}`}>
                      {fmtProfit(row.profit)}
                    </td>
                    <td className={`px-5 py-3.5 text-right tabular-nums font-semibold ${profitCls(row.yield)}`}>
                      {row.yield > 0 ? '+' : ''}{row.yield.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function StatsPage({ searchParams }: PageProps) {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) redirect('/login')

  const userPlan = (session?.user as { plan?: string })?.plan ?? 'FREE'
  const isFree   = userPlan === 'FREE'

  // ── Período ───────────────────────────────────────────────────────────────
  const params = await searchParams
  const period = typeof params['period'] === 'string' ? params['period'] : 'all'

  let dateFrom: Date | undefined
  const now = new Date()
  if      (period === '7d')  dateFrom = new Date(now.getTime() -   7 * 24 * 60 * 60 * 1000)
  else if (period === '30d') dateFrom = new Date(now.getTime() -  30 * 24 * 60 * 60 * 1000)
  else if (period === '3m')  dateFrom = new Date(now.getTime() -  90 * 24 * 60 * 60 * 1000)
  else if (period === '1y')  dateFrom = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

  const evolutionDays = period === '7d' ? 7 : period === '30d' ? 30 : period === '3m' ? 90 : period === '1y' ? 365 : 9999

  // Siempre cargamos los datos — en FREE los mostramos borrosos
  const [stats, evolution, advanced, compRecords, historicalMonthlyPnl] = await Promise.all([
    getStatsData(userId, dateFrom),
    getBankrollEvolution(userId, evolutionDays),
    getAdvancedStats(userId, dateFrom),
    prisma.betRecord.findMany({
      where: {
        userId, deletedAt: null,
        status: { in: ['WON', 'LOST', 'CASHOUT'] },
        competition: { not: null },
        ...(dateFrom ? { datePlaced: { gte: dateFrom } } : {}),
      },
      select: { competition: true, grossProfit: true, totalStake: true, status: true },
    }),
    // El gráfico mensual siempre muestra los últimos 12 meses sin filtro de período
    dateFrom ? getStatsData(userId).then((s) => s.monthlyPnl) : Promise.resolve(null),
  ])

  const compMap = new Map<string, { count: number; won: number; profit: number; stake: number }>()
  for (const r of compRecords) {
    const key   = r.competition!
    const entry = compMap.get(key) ?? { count: 0, won: 0, profit: 0, stake: 0 }
    entry.count++
    if (r.status === 'WON') entry.won++
    entry.profit += r.grossProfit ? parseFloat(r.grossProfit.toString()) : 0
    entry.stake  += parseFloat(r.totalStake.toString())
    compMap.set(key, entry)
  }
  const byCompetition = [...compMap.entries()]
    .map(([name, v]) => ({
      name,
      count:   v.count,
      won:     v.won,
      winRate: v.count > 0 ? (v.won / v.count) * 100 : 0,
      profit:  v.profit,
      yield:   v.stake > 0 ? (v.profit / v.stake) * 100 : 0,
    }))
    .filter((v) => v.count >= 2)
    .sort((a, b) => b.profit - a.profit)

  return (
    <div className="space-y-8 max-w-4xl">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Estadísticas</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isFree
              ? 'Análisis avanzado de rendimiento · Plan PRO'
              : period === 'all'
                ? `Análisis histórico · ${stats.totalAll} operaciones`
                : `${PERIOD_LABEL[period] ?? period} · ${stats.totalAll} operaciones`}
          </p>
        </div>
        <PeriodNav current={period} />
      </div>

      {isFree ? (
        /* ── FREE: contenido borroso + overlay de upgrade ──────────────── */
        <div className="relative">
          {/* Stats reales pero con blur — el usuario intuye sus propios datos */}
          <div
            className="select-none pointer-events-none"
            style={{ filter: 'blur(5px)', opacity: 0.7 }}
            aria-hidden="true"
          >
            <StatsContent stats={stats} evolution={evolution} advanced={advanced} byCompetition={byCompetition} period={period} monthlyPnlOverride={historicalMonthlyPnl} />
          </div>

          {/* Overlay de upgrade */}
          <UpgradeOverlay />
        </div>
      ) : (
        /* ── PRO: estadísticas completas ────────────────────────────────── */
        <StatsContent stats={stats} evolution={evolution} advanced={advanced} byCompetition={byCompetition} period={period} monthlyPnlOverride={historicalMonthlyPnl} />
      )}

    </div>
  )
}
