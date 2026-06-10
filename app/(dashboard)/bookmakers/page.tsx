import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { AddBookmakerModal } from './_components/add-bookmaker-modal'
import { ManageBookmaker }  from './_components/manage-bookmaker'
import { BankrollManager }  from './_components/bankroll-manager'

export const metadata: Metadata = { title: 'Casas de Apuestas — DualStats Tracker' }

const STATUS_META: Record<string, { label: string; cls: string }> = {
  ACTIVE:    { label: 'Activa',     cls: 'bg-green-100 text-green-700 border border-green-200'  },
  LIMITED:   { label: 'Limitada',  cls: 'bg-amber-100 text-amber-700 border border-amber-200'  },
  GUBBED:    { label: 'Gubbed',    cls: 'bg-red-100 text-red-700 border border-red-200'        },
  CLOSED:    { label: 'Cerrada',   cls: 'bg-gray-100 text-gray-600 border border-gray-200'     },
  SUSPENDED: { label: 'Suspendida',cls: 'bg-slate-100 text-slate-500 border border-slate-200'  },
}

export default async function BookmakersPage() {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) redirect('/login')

  const [bookmakers, bankrolls, betStatsByBankroll, activeBetsByBankroll] = await Promise.all([
    prisma.bookmaker.findMany({
      where:   { userId },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      select: {
        id: true, name: true, etiqueta: true, color: true, status: true, currency: true,
        notes: true, bankrollId: true,
        currentBalance: true, totalStaked: true, totalProfit: true, totalReturn: true,
        operationCount: true,
      },
    }),
    prisma.bankroll.findMany({
      where:   { userId, isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, description: true, color: true,
        _count: { select: { bookmakers: true } },
      },
    }),
    // P&L y stake por bankroll calculados desde BetRecords
    prisma.betRecord.groupBy({
      by:    ['bankrollId'],
      where: { userId, bankrollId: { not: null }, deletedAt: null },
      _sum:   { totalStake: true, grossProfit: true },
      _count: { _all: true },
    }),
    // Apuestas en juego por bankroll
    prisma.betRecord.groupBy({
      by:    ['bankrollId'],
      where: { userId, bankrollId: { not: null }, deletedAt: null, status: 'PLACED' },
      _count: { _all: true },
    }),
  ])

  const existingNames = bookmakers.map((b) => b.name)
  const userPlan      = (session?.user as { plan?: string })?.plan ?? 'FREE'

  const totalBalance  = bookmakers.reduce((a, b) => a + parseFloat(b.currentBalance.toString()), 0)
  const totalProfit   = bookmakers.reduce((a, b) => a + parseFloat(b.totalProfit.toString()), 0)
  const activeCount   = bookmakers.filter((b) => b.status === 'ACTIVE').length
  const FREE_BM_LIMIT = 3

  // Enrich bankrolls with bet-based metrics
  const bankrollsForManager = bankrolls.map((br) => {
    const stats  = betStatsByBankroll.find((s) => s.bankrollId === br.id)
    const active = activeBetsByBankroll.find((s) => s.bankrollId === br.id)
    return {
      id:          br.id,
      name:        br.name,
      description: br.description,
      color:       br.color,
      _count:      br._count,
      totalStaked: parseFloat((stats?._sum.totalStake?.toString()   ?? '0')),
      totalProfit: parseFloat((stats?._sum.grossProfit?.toString()  ?? '0')),
      totalBets:   stats?._count._all  ?? 0,
      activeBets:  active?._count._all ?? 0,
    }
  })

  const bankrollOptions = bankrolls.map((br) => ({ id: br.id, name: br.name, color: br.color }))

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Casas de Apuestas</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {activeCount} activas · {bookmakers.length} total
          </p>
        </div>
        <AddBookmakerModal existingNames={existingNames} />
      </div>

      {/* Banner límite FREE */}
      {userPlan === 'FREE' && (
        <div className={`rounded-xl border px-4 py-3 flex items-center justify-between gap-3 text-sm ${
          activeCount >= FREE_BM_LIMIT
            ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
            : activeCount >= FREE_BM_LIMIT - 1
              ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300'
              : 'bg-muted/40 border-border text-muted-foreground'
        }`}>
          <div className="flex items-center gap-2">
            <span>{activeCount >= FREE_BM_LIMIT ? '🔒' : '🏦'}</span>
            <span>
              {activeCount >= FREE_BM_LIMIT
                ? 'Has alcanzado el límite de 3 casas activas del plan FREE.'
                : `${activeCount} / ${FREE_BM_LIMIT} casas activas (plan FREE)`}
            </span>
          </div>
          <a href="/settings" className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline">
            Actualizar a PRO →
          </a>
        </div>
      )}

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Saldo total</p>
          <p className="text-2xl font-bold mt-1.5 tabular-nums">
            {totalBalance.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
          </p>
        </div>
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">P&L global</p>
          <p className={`text-2xl font-bold mt-1.5 tabular-nums ${totalProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {totalProfit >= 0 ? '+' : ''}{totalProfit.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
          </p>
        </div>
        <div className="rounded-xl border bg-card p-5 shadow-sm col-span-2 sm:col-span-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Casas activas</p>
          <p className="text-2xl font-bold mt-1.5">{activeCount}</p>
        </div>
      </div>

      {/* Bankroll Manager */}
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <BankrollManager bankrolls={bankrollsForManager} />
      </div>

      {/* Bookmakers Table */}
      {bookmakers.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <p className="text-3xl mb-3">🏦</p>
          <p className="font-semibold">Sin casas de apuestas</p>
          <p className="text-sm text-muted-foreground mt-1">
            Usa el botón <strong>Añadir casa</strong> para incorporar las casas donde operas.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b bg-muted/30">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Todas las casas</h2>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[480px]">
            <thead className="border-b bg-muted/20">
              <tr>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Casa</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Estado</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Saldo</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden md:table-cell">Stakeado</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">P&L</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden lg:table-cell">Ops.</th>
                <th className="px-4 py-3 text-xs uppercase tracking-wide"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {bookmakers.map((bm) => {
                const profit    = parseFloat(bm.totalProfit.toString())
                const staked    = parseFloat(bm.totalStaked.toString())
                const balance   = parseFloat(bm.currentBalance.toString())
                const profitCls = profit > 0 ? 'text-green-600 font-semibold' : profit < 0 ? 'text-red-600 font-semibold' : 'text-muted-foreground'
                const yieldPct  = staked > 0 ? (profit / staked * 100).toFixed(2) : null
                const sm        = STATUS_META[bm.status] ?? STATUS_META['ACTIVE']!
                const bankroll  = bankrollOptions.find((br) => br.id === bm.bankrollId)

                const bmForManage = {
                  id:             bm.id,
                  name:           bm.name,
                  notes:          bm.notes,
                  status:         bm.status,
                  bankrollId:     bm.bankrollId,
                  currentBalance: balance,
                }

                return (
                  <tr key={bm.id} className={`hover:bg-muted/20 transition-colors ${bm.status === 'SUSPENDED' ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-2.5">
                        {bm.color && (
                          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: bm.color }} />
                        )}
                        <div>
                          <p className="font-semibold">
                            {bm.name}{bm.etiqueta ? ` · ${bm.etiqueta}` : ''}
                          </p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <p className="text-xs text-muted-foreground">{bm.currency}</p>
                            {bankroll && (
                              <>
                                <span className="text-muted-foreground">·</span>
                                <span
                                  className="text-xs font-medium px-1.5 py-0.5 rounded-full"
                                  style={{ backgroundColor: bankroll.color + '20', color: bankroll.color }}
                                >
                                  {bankroll.name}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className={`inline-flex items-center text-xs font-semibold rounded-full px-2.5 py-0.5 ${sm.cls}`}>
                        {sm.label}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-sm font-semibold tabular-nums">
                      {balance.toLocaleString('es-ES', { style: 'currency', currency: bm.currency })}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-xs text-muted-foreground tabular-nums hidden md:table-cell">
                      {staked.toLocaleString('es-ES', { style: 'currency', currency: bm.currency })}
                    </td>
                    <td className="px-4 py-3.5 text-right tabular-nums">
                      <p className={`font-mono text-xs ${profitCls}`}>
                        {profit >= 0 ? '+' : ''}{profit.toLocaleString('es-ES', { style: 'currency', currency: bm.currency })}
                      </p>
                      {yieldPct !== null && (
                        <p className={`text-xs ${profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {profit >= 0 ? '+' : ''}{yieldPct}% yield
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right text-sm text-muted-foreground hidden lg:table-cell">
                      {bm.operationCount}
                    </td>
                    <td className="px-4 py-3.5">
                      <ManageBookmaker bookmaker={bmForManage} bankrolls={bankrollOptions} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  )
}
