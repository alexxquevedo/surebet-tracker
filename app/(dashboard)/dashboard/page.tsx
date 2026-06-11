import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { getDashboardMetrics, getRecentBetRecords, getBankrollEvolution } from '@/lib/queries/dashboard'
import { BankrollEvolutionChart } from '@/app/(dashboard)/stats/_components/bankroll-evolution-chart'
import { StrategyChart } from './_components/strategy-chart'
import { SetupProgress } from './_components/setup-progress'
import { formatCurrency, formatPercentage, formatDate } from '@/lib/utils/format'
import type {
  BankrollMetrics,
  TypeBreakdown,
  BookmakerBreakdown,
  AdvancedStats,
  PeriodStat,
  BetRecordListItem,
  BetType,
  BetStatus,
} from '@/types/domain'

export const metadata: Metadata = { title: 'Dashboard — DualStats Tracker' }

// ─── Metadatos visuales por tipo de apuesta ────────────────────────────────
const BET_TYPE_META: Record<BetType, { label: string; emoji: string; cls: string }> = {
  ARBITRAGE: { label: 'Surebets',  emoji: '⚡', cls: 'bg-indigo-100 text-indigo-700 border border-indigo-200' },
  MIDDLE:    { label: 'Middlebet', emoji: '🎯', cls: 'bg-violet-100 text-violet-700 border border-violet-200' },
  SINGLE:    { label: 'Single',    emoji: '⚽', cls: 'bg-blue-100 text-blue-700 border border-blue-200'       },
  COMBO:     { label: 'Combo',     emoji: '📋', cls: 'bg-orange-100 text-orange-700 border border-orange-200' },
  CASINO:    { label: 'Casino',    emoji: '🎰', cls: 'bg-pink-100 text-pink-700 border border-pink-200'       },
  CUSTOM:    { label: 'Custom',    emoji: '📝', cls: 'bg-gray-100 text-gray-700 border border-gray-200'       },
}

const STATUS_META: Record<BetStatus, { label: string; cls: string }> = {
  PLACED:      { label: 'En juego',  cls: 'bg-amber-100 text-amber-700 border border-amber-200'  },
  WON:         { label: 'Ganada',    cls: 'bg-green-100 text-green-700 border border-green-200'  },
  LOST:        { label: 'Perdida',   cls: 'bg-red-100 text-red-700 border border-red-200'        },
  VOID:        { label: 'Anulada',   cls: 'bg-gray-100 text-gray-600 border border-gray-200'     },
  CASHOUT:     { label: 'Cashout',   cls: 'bg-blue-100 text-blue-700 border border-blue-200'     },
  PARTIAL_WIN: { label: 'Parcial',   cls: 'bg-teal-100 text-teal-700 border border-teal-200'     },
}

// ─── Helpers de formato ────────────────────────────────────────────────────

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
    // period = 'W2026-06-01' → 'Sem. 01/06'
    return `Sem. ${formatDate(period.slice(1) + 'T00:00:00Z', 'dd/MM')}`
  }
  if (kind === 'month') {
    // period = '2026-06'
    const parts = period.split('-')
    const monthIdx = parseInt(parts[1] ?? '1', 10) - 1
    const names = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
    return `${names[monthIdx] ?? '?'} ${parts[0] ?? ''}`
  }
  // period = '2026-06-10'
  return formatDate(period + 'T00:00:00Z', 'dd MMM yyyy')
}

// ════════════════════════════════════════════════════════════════════════════
// PÁGINA PRINCIPAL (RSC asíncrono)
// ════════════════════════════════════════════════════════════════════════════

interface DashboardPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) redirect('/login')

  const params     = await searchParams
  const bankrollId = typeof params['bankroll'] === 'string' ? params['bankroll'] : undefined

  const [metrics, recentRecords, evolution, bankrolls, setupData] = await Promise.all([
    getDashboardMetrics(userId, bankrollId),
    getRecentBetRecords(userId, 5),
    getBankrollEvolution(userId),
    prisma.bankroll.findMany({
      where:   { userId, isActive: true },
      select:  { id: true, name: true, color: true },
      orderBy: { name: 'asc' },
    }),
    prisma.user.findUnique({
      where:  { id: userId },
      select: {
        telegramId: true,
        bookmakers: {
          where:   { status: 'ACTIVE' },
          select:  { initialCapital: true },
          take:    50,
        },
      },
    }),
  ])

  const setupStep1 = (setupData?.bookmakers.length ?? 0) > 0
  const setupStep2 = setupStep1 && (setupData?.bookmakers.every((b) => b.initialCapital !== null) ?? false)
  const setupStep3 = !!setupData?.telegramId

  const { bankroll, byType, byBookmaker, advanced } = metrics
  const hasSettled = advanced.settledOperations > 0
  const activeBankroll = bankrolls.find((b) => b.id === bankrollId)

  return (
    <div className="space-y-8">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Bienvenido, {session?.user?.name ?? session?.user?.email ?? 'Usuario'}
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground hidden sm:block">
          <p>{advanced.totalOperations} operaciones totales</p>
          <p>{advanced.settledOperations} liquidadas · {advanced.placedOperations} en juego</p>
        </div>
      </div>

      {/* ── Setup progress ──────────────────────────────────────────────── */}
      <SetupProgress step1Done={setupStep1} step2Done={setupStep2} step3Done={setupStep3} />

      {/* ── Bankroll filter tabs ────────────────────────────────────────── */}
      {bankrolls.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/dashboard"
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              !bankrollId
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground hover:bg-muted'
            }`}
          >
            🌍 Global
          </a>
          {bankrolls.map((br) => (
            <a
              key={br.id}
              href={`/dashboard?bankroll=${br.id}`}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                bankrollId === br.id
                  ? 'text-white border-transparent shadow-sm'
                  : 'bg-background text-muted-foreground hover:bg-muted'
              }`}
              style={bankrollId === br.id ? { backgroundColor: br.color, borderColor: br.color } : {}}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: br.color }} />
              {br.name}
            </a>
          ))}
          {activeBankroll && (
            <span className="text-xs text-muted-foreground ml-1">
              — viendo sólo {activeBankroll.name}
            </span>
          )}
        </div>
      )}

      {/* ── S1: Bankroll Global ─────────────────────────────────────────── */}
      <section>
        <SectionHeading>Bankroll Global</SectionHeading>
        <BankrollSection bankroll={bankroll} />
        {/* Bankroll evolution chart (DailySnapshot) */}
        <div className="mt-4 rounded-lg border bg-card p-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
            Evolución del Bankroll
          </p>
          <p className="text-xs text-muted-foreground mb-3">
            Saldo total a cierre de día · últimos 90 días
          </p>
          <BankrollEvolutionChart
            data={evolution.points}
            initialCapital={evolution.initialCapital}
          />
        </div>
      </section>

      {/* ── S2 + S3: Estrategia y Casas ────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <section className="lg:col-span-3">
          <SectionHeading>Rendimiento por Estrategia</SectionHeading>
          <ByTypeSection byType={byType} />
          {/* Strategy bar chart */}
          {byType.length > 0 && (
            <div className="mt-4 rounded-lg border bg-card p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                P&L por Estrategia
              </p>
              <StrategyChart data={byType} />
            </div>
          )}
        </section>

        <section className="lg:col-span-2">
          <SectionHeading>Casas de Apuestas</SectionHeading>
          <BookmakersSection bookmakers={byBookmaker} />
        </section>
      </div>

      {/* ── S4: Estadísticas Avanzadas ──────────────────────────────────── */}
      {hasSettled && (
        <section>
          <SectionHeading>Estadísticas Avanzadas</SectionHeading>
          <AdvancedSection advanced={advanced} />
        </section>
      )}

      {/* ── S5: Últimas Operaciones ─────────────────────────────────────── */}
      <section>
        <SectionHeading>Últimas Operaciones</SectionHeading>
        <RecentRecordsSection records={recentRecords} />
      </section>

    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// S1 — BANKROLL GLOBAL
// ════════════════════════════════════════════════════════════════════════════

function BankrollSection({ bankroll }: { bankroll: BankrollMetrics }) {
  const barWidth = Math.min(100, Math.max(0, bankroll.accumulatedReturn))
  const returnPositive = bankroll.accumulatedReturn >= 0

  return (
    <div className="space-y-4">

      {/* 4 KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard
          label="Capital Inicial"
          value={formatCurrency(bankroll.initialCapital)}
          subtext="Suma de depósitos iniciales"
        />
        <KpiCard
          label="Saldo actual casas"
          value={formatCurrency(bankroll.currentTotal)}
          subtext={`${formatCurrency(bankroll.availableTotal)} disponible`}
        />
        <KpiCard
          label="Beneficio Neto"
          value={formatProfit(bankroll.netProfit)}
          valueCls={profitCls(bankroll.netProfit)}
          subtext={`Stakeado: ${formatCurrency(bankroll.totalStaked)}`}
        />
        <KpiCard
          label="En Juego"
          value={formatCurrency(bankroll.totalInPlay)}
          subtext="Comprometido en PLACED"
        />
      </div>

      {/* Rentabilidad acumulada + ROI + Yield */}
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
          {/* Rentabilidad acumulada */}
          <div>
            <p className="text-xs text-muted-foreground">Rentabilidad Acumulada</p>
            <p className={`text-4xl font-bold mt-1 ${returnPositive ? 'text-green-600' : 'text-red-600'}`}>
              {formatPercentage(bankroll.accumulatedReturn)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              (Capital actual − Capital inicial) / Capital inicial
            </p>
          </div>

          {/* ROI y Yield en columnas */}
          <div className="flex flex-wrap gap-4 sm:gap-8">
            <div>
              <p className="text-xs text-muted-foreground">ROI sobre Capital</p>
              <p className={`text-2xl font-bold mt-1 ${profitCls(bankroll.roi)}`}>
                {formatPercentage(bankroll.roi)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Beneficio / Capital inicial
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Yield sobre Turnover</p>
              <p className={`text-2xl font-bold mt-1 ${profitCls(bankroll.yield)}`}>
                {formatPercentage(bankroll.yield)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Beneficio / Total stakeado
              </p>
            </div>
          </div>
        </div>

        {/* Barra de progreso */}
        <div className="h-2.5 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${returnPositive ? 'bg-green-500' : 'bg-red-500'}`}
            style={{ width: `${barWidth}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-muted-foreground mt-2">
          <span>{formatCurrency(bankroll.initialCapital)} inicial</span>
          <span>{formatCurrency(bankroll.currentTotal)} actual</span>
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// S2 — RENDIMIENTO POR ESTRATEGIA
// ════════════════════════════════════════════════════════════════════════════

function ByTypeSection({ byType }: { byType: TypeBreakdown[] }) {
  if (byType.length === 0) {
    return (
      <EmptyState message="Sin operaciones liquidadas todavía." />
    )
  }

  return (
    <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[320px]">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">
              Estrategia
            </th>
            <th className="text-right px-4 py-3 font-medium text-muted-foreground text-xs">
              Ops.
            </th>
            <th className="text-right px-4 py-3 font-medium text-muted-foreground text-xs">
              P&L
            </th>
            <th className="text-right px-4 py-3 font-medium text-muted-foreground text-xs">
              Yield
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {byType.map((row) => {
            const meta = BET_TYPE_META[row.type]
            return (
              <tr key={row.type} className="hover:bg-muted/20 transition-colors">
                <td className="px-4 py-3.5">
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-1 ${meta.cls}`}
                  >
                    <span aria-hidden="true">{meta.emoji}</span>
                    <span>{meta.label}</span>
                  </span>
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums text-muted-foreground">
                  {row.settledCount}
                </td>
                <td className={`px-4 py-3.5 text-right tabular-nums font-semibold ${profitCls(row.profit)}`}>
                  {formatProfit(row.profit)}
                </td>
                <td className={`px-4 py-3.5 text-right tabular-nums text-sm ${profitCls(row.yield)}`}>
                  {formatPercentage(row.yield)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// S3 — CASAS DE APUESTAS
// ════════════════════════════════════════════════════════════════════════════

function BookmakersSection({ bookmakers }: { bookmakers: BookmakerBreakdown[] }) {
  if (bookmakers.length === 0) {
    return <EmptyState message="Sin casas de apuestas configuradas." />
  }

  return (
    <div className="space-y-2">
      {bookmakers.map((bm) => (
        <div
          key={bm.id}
          className="rounded-lg border bg-card px-4 py-3 flex items-center gap-3"
        >
          {/* Color dot */}
          <div
            className="w-3 h-3 rounded-full flex-shrink-0 ring-1 ring-black/5"
            style={{ backgroundColor: bm.color ?? '#6366f1' }}
          />

          {/* Name + stats */}
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">{bm.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {bm.operationCount > 0
                ? `${bm.operationCount} ops · Yield ${formatPercentage(bm.yield)}`
                : 'Sin operaciones aún'}
            </p>
          </div>

          {/* Balance + profit */}
          <div className="text-right flex-shrink-0">
            <p className="font-semibold text-sm tabular-nums">
              {formatCurrency(bm.currentBalance)}
            </p>
            {bm.operationCount > 0 && (
              <p className={`text-xs font-medium tabular-nums ${profitCls(bm.totalProfit)}`}>
                {formatProfit(bm.totalProfit)}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// S4 — ESTADÍSTICAS AVANZADAS
// ════════════════════════════════════════════════════════════════════════════

function AdvancedSection({ advanced }: { advanced: AdvancedStats }) {
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
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
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

// ════════════════════════════════════════════════════════════════════════════
// S5 — ÚLTIMAS OPERACIONES
// ════════════════════════════════════════════════════════════════════════════

function RecentRecordsSection({ records }: { records: BetRecordListItem[] }) {
  if (records.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-10 text-center">
        <p className="font-medium text-muted-foreground">Sin operaciones registradas</p>
        <p className="text-sm text-muted-foreground mt-1">
          Registra tu primera apuesta desde el panel de entrada.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="divide-y">
        {records.map((record) => {
          const typeMeta = BET_TYPE_META[record.type]
          const statusMeta = STATUS_META[record.status]

          // Nombre de las casas: piernas multi-bookie o bookmaker principal
          const bookmakerLabel =
            record.legs.length > 0
              ? record.legs.map((l) => l.bookmaker.name).join(' + ')
              : (record.primaryBookmaker?.name ?? '—')

          // Importe a mostrar: P&L si liquidado, potencial si en juego
          const amountDisplay =
            record.grossProfit !== null ? (
              <p className={`text-sm font-semibold tabular-nums ${profitCls(record.grossProfit)}`}>
                {formatProfit(record.grossProfit)}
              </p>
            ) : (
              <p className="text-sm tabular-nums text-muted-foreground">
                {formatCurrency(record.potentialReturn ?? record.totalStake)}
              </p>
            )

          return (
            <a
              href="/records"
              key={record.id}
              className="flex items-center gap-4 px-5 py-4 hover:bg-muted/30 transition-colors"
            >
              {/* Tipo */}
              <span
                className={`hidden sm:inline-flex items-center gap-1 text-xs font-medium rounded-full px-2.5 py-1 flex-shrink-0 ${typeMeta.cls}`}
              >
                <span aria-hidden="true">{typeMeta.emoji}</span>
                <span>{typeMeta.label}</span>
              </span>
              {/* Emoji visible en móvil */}
              <span className="sm:hidden text-base flex-shrink-0" aria-hidden="true">
                {typeMeta.emoji}
              </span>

              {/* Evento */}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">
                  {record.title ?? record.eventName ?? 'Sin título'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {bookmakerLabel} ·{' '}
                  <span className="tabular-nums">{formatCurrency(record.totalStake)}</span>
                  {record.dateSettled !== null
                    ? ` · ${formatDate(record.dateSettled)}`
                    : ` · ${formatDate(record.datePlaced)}`}
                </p>
              </div>

              {/* P&L + estado */}
              <div className="text-right flex-shrink-0">
                {amountDisplay}
                <span
                  className={`inline-block text-xs font-medium rounded-full px-2 py-0.5 mt-0.5 ${statusMeta.cls}`}
                >
                  {statusMeta.label}
                </span>
              </div>
            </a>
          )
        })}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// COMPONENTES DE APOYO
// ════════════════════════════════════════════════════════════════════════════

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
      {children}
    </h2>
  )
}

function KpiCard({
  label,
  value,
  subtext,
  valueCls = '',
}: {
  label: string
  value: string
  subtext?: string
  valueCls?: string
}) {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`text-xl sm:text-3xl font-bold mt-2 tabular-nums break-all ${valueCls}`}>{value}</p>
      {subtext !== undefined && (
        <p className="text-xs text-muted-foreground mt-1.5">{subtext}</p>
      )}
    </div>
  )
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
    <div className="rounded-lg border bg-card p-4">
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

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border bg-card p-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}
