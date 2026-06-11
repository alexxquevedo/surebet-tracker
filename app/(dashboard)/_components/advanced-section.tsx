import { formatCurrency, formatDate } from '@/lib/utils/format'
import type { AdvancedStats, PeriodStat } from '@/types/domain'

function profitCls(value: number | null): string {
  if (value === null) return 'text-muted-foreground'
  if (value > 0) return 'text-green-600'
  if (value < 0) return 'text-red-600'
  return 'text-muted-foreground'
}

function formatProfit(value: number | null): string {
  if (value === null) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${formatCurrency(value)}`
}

function formatPeriodLabel(period: string, kind: 'day' | 'week' | 'month'): string {
  if (kind === 'week') {
    return `Sem. ${formatDate(period.slice(1) + 'T00:00:00Z', 'dd/MM')}`
  }
  if (kind === 'month') {
    const parts = period.split('-')
    const monthIdx = parseInt(parts[1] ?? '1', 10) - 1
    const names = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
    return `${names[monthIdx] ?? '?'} ${parts[0] ?? ''}`
  }
  return formatDate(period + 'T00:00:00Z', 'dd MMM yyyy')
}

function MetricCard({
  label,
  value,
  valueCls = '',
}: {
  label: string
  value: string
  valueCls?: string
}) {
  return (
    <div className="rounded-lg border bg-card px-2 sm:px-4 py-3">
      <p className="text-[10px] sm:text-xs text-muted-foreground truncate">{label}</p>
      <p className={`text-xs sm:text-sm font-semibold mt-0.5 tabular-nums ${valueCls}`}>{value}</p>
    </div>
  )
}

function WindowCard({
  label,
  profit,
  ops,
  staked,
}: {
  label: string
  profit: number
  ops: number
  staked: number
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${profitCls(profit)}`}>
        {formatProfit(profit)}
      </p>
      <p className="text-xs text-muted-foreground mt-1">
        {ops} ops · {formatCurrency(staked)} stakeado
      </p>
    </div>
  )
}

function PeriodBlock({
  label,
  stat,
  kind,
  sign,
}: {
  label: string
  stat: PeriodStat | null
  kind: 'day' | 'week' | 'month'
  sign: 'positive' | 'negative'
}) {
  const colorCls = sign === 'positive' ? 'text-green-600' : 'text-red-600'

  return (
    <div className="rounded-lg border bg-card p-3 sm:p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      {stat !== null ? (
        <>
          <p className={`text-lg font-bold mt-1 tabular-nums ${colorCls}`}>
            {formatProfit(stat.profit)}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {formatPeriodLabel(stat.period, kind)} · {stat.operationCount} ops.
          </p>
        </>
      ) : (
        <p className="text-muted-foreground text-sm mt-2">Sin datos</p>
      )}
    </div>
  )
}

export function AdvancedSection({ advanced }: { advanced: AdvancedStats }) {
  const { streaks, bestDay, worstDay, bestWeek, worstWeek, bestMonth, worstMonth } = advanced

  return (
    <div className="space-y-4">

      {/* Ventanas temporales */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <WindowCard
          label="Últimos 7 días"
          profit={advanced.last7.profit}
          ops={advanced.last7.operations}
          staked={advanced.last7.staked}
        />
        <WindowCard
          label="Últimos 30 días"
          profit={advanced.last30.profit}
          ops={advanced.last30.operations}
          staked={advanced.last30.staked}
        />
      </div>

      {/* Rachas */}
      <div className="rounded-lg border bg-card p-5">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">
          Rachas
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
          <div>
            <p className="text-xs text-muted-foreground">Racha actual</p>
            <p className={`text-2xl font-bold mt-1 ${
              streaks.currentWin > 0
                ? 'text-green-600'
                : streaks.currentLoss > 0
                  ? 'text-red-600'
                  : 'text-muted-foreground'
            }`}>
              {streaks.currentWin > 0
                ? `+${streaks.currentWin} 🔥`
                : streaks.currentLoss > 0
                  ? `-${streaks.currentLoss} 📉`
                  : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Días activos</p>
            <p className="text-2xl font-bold mt-1">{advanced.activeDays}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Máx. victorias seguidas</p>
            <p className="text-2xl font-bold mt-1 text-green-600">+{streaks.maxWin}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Máx. pérdidas seguidas</p>
            <p className="text-2xl font-bold mt-1 text-red-600">-{streaks.maxLoss}</p>
          </div>
        </div>
      </div>

      {/* Promedios */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <MetricCard
          label="Promedio diario"
          value={formatProfit(advanced.avgDailyProfit)}
          valueCls={profitCls(advanced.avgDailyProfit)}
        />
        <MetricCard
          label="Promedio semanal"
          value={formatProfit(advanced.avgWeeklyProfit)}
          valueCls={profitCls(advanced.avgWeeklyProfit)}
        />
        <MetricCard
          label="Promedio mensual"
          value={formatProfit(advanced.avgMonthlyProfit)}
          valueCls={profitCls(advanced.avgMonthlyProfit)}
        />
      </div>

      {/* Mejor / peor período */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <PeriodBlock kind="day"   label="Mejor Día"    stat={bestDay}    sign="positive" />
        <PeriodBlock kind="day"   label="Peor Día"     stat={worstDay}   sign="negative" />
        <PeriodBlock kind="week"  label="Mejor Semana" stat={bestWeek}   sign="positive" />
        <PeriodBlock kind="week"  label="Peor Semana"  stat={worstWeek}  sign="negative" />
        <PeriodBlock kind="month" label="Mejor Mes"    stat={bestMonth}  sign="positive" />
        <PeriodBlock kind="month" label="Peor Mes"     stat={worstMonth} sign="negative" />
      </div>

    </div>
  )
}
