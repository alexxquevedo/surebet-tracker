import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'
import { getStatsData } from '@/lib/queries/stats'
import { DistributionChart } from './_components/distribution-chart'
import { WinRateBars } from './_components/win-rate-bars'

export const metadata: Metadata = { title: 'Estadísticas — Surebet Tracker' }

function profitCls(v: number) {
  if (v > 0) return 'text-green-600'
  if (v < 0) return 'text-red-600'
  return 'text-muted-foreground'
}

function fmtProfit(v: number) {
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`
}

export default async function StatsPage() {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) redirect('/login')

  const stats = await getStatsData(userId)

  const noData = stats.totalAll === 0

  return (
    <div className="space-y-8 max-w-4xl">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Estadísticas</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Análisis detallado de tus {stats.totalAll} operaciones registradas
        </p>
      </div>

      {noData ? (
        <div className="rounded-xl border border-dashed p-16 text-center">
          <p className="text-4xl mb-3">📈</p>
          <p className="font-semibold text-lg">Sin datos todavía</p>
          <p className="text-sm text-muted-foreground mt-1">
            Registra y liquida apuestas para ver tus estadísticas aquí.
          </p>
        </div>
      ) : (
        <>
          {/* ── KPI Row ────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="rounded-xl border bg-card p-5 shadow-sm">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Ops. liquidadas</p>
              <p className="text-2xl font-bold mt-2 tabular-nums">{stats.totalSettled}</p>
            </div>
            <div className="rounded-xl border bg-card p-5 shadow-sm">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Win Rate</p>
              <p className={`text-2xl font-bold mt-2 tabular-nums ${stats.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>
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

          {/* ── Distribución + Win rate por deporte ────────────────────────── */}
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

          {/* ── Win rate por casa ───────────────────────────────────────────── */}
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

          {/* ── Tabla detallada por deporte ─────────────────────────────────── */}
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
                        <td className={`px-5 py-3.5 text-right tabular-nums font-semibold ${row.winRate >= 55 ? 'text-green-600' : row.winRate >= 45 ? 'text-amber-600' : 'text-red-600'}`}>
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
        </>
      )}

    </div>
  )
}
