import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'
import { getStatsData } from '@/lib/queries/stats'
import { DistributionChart } from './_components/distribution-chart'
import { WinRateBars } from './_components/win-rate-bars'

export const metadata: Metadata = { title: 'Estadísticas — DualStats Tracker' }

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
            '🏆 Win rate por deporte',
            '🏦 Rendimiento por casa',
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

function StatsContent({ stats }: { stats: Awaited<ReturnType<typeof getStatsData>> }) {
  const noData = stats.totalAll === 0

  if (noData) {
    return (
      <div className="rounded-xl border border-dashed p-16 text-center">
        <p className="text-4xl mb-3">📈</p>
        <p className="font-semibold text-lg">Sin datos todavía</p>
        <p className="text-sm text-muted-foreground mt-1">
          Registra y liquida apuestas para ver tus estadísticas aquí.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ── KPI Row ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Ops. liquidadas</p>
          <p className="text-2xl font-bold mt-2 tabular-nums">{stats.totalSettled}</p>
        </div>
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Win Rate</p>
          <p className={`text-2xl font-bold mt-2 tabular-nums ${stats.winRate >= 50 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {stats.winRate.toFixed(1)}%
          </p>
        </div>
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Stake promedio</p>
          <p className="text-2xl font-bold mt-2 tabular-nums">
            {stats.avgStake.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })}
          </p>
        </div>
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">P&L total</p>
          <p className={`text-2xl font-bold mt-2 tabular-nums ${profitCls(stats.totalProfit)}`}>
            {fmtProfit(stats.totalProfit)}
          </p>
        </div>
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
            <table className="w-full text-sm min-w-[480px]">
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
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function StatsPage() {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) redirect('/login')

  const userPlan = (session?.user as { plan?: string })?.plan ?? 'FREE'
  const isFree   = userPlan === 'FREE'

  // Siempre cargamos los datos — en FREE los mostramos borrosos
  const stats = await getStatsData(userId)

  return (
    <div className="space-y-8 max-w-4xl">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Estadísticas</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {isFree
            ? 'Análisis avanzado de rendimiento · Plan PRO'
            : `Análisis detallado de tus ${stats.totalAll} operaciones registradas`}
        </p>
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
            <StatsContent stats={stats} />
          </div>

          {/* Overlay de upgrade */}
          <UpgradeOverlay />
        </div>
      ) : (
        /* ── PRO: estadísticas completas ────────────────────────────────── */
        <StatsContent stats={stats} />
      )}

    </div>
  )
}
