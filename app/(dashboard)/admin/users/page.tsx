import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { type Prisma } from '@prisma/client'

export const metadata: Metadata = { title: 'Admin · Usuarios — DualStats Tracker' }

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const PLAN_BADGE: Record<string, string> = {
  FREE:        'bg-gray-100 text-gray-500 border border-gray-200',
  PRO:         'bg-blue-100 text-blue-700 border border-blue-200',
  PRO_TRACKER: 'bg-indigo-100 text-indigo-700 border border-indigo-200',
  ENTERPRISE:  'bg-purple-100 text-purple-700 border border-purple-200',
}
const PLAN_LABEL: Record<string, string> = {
  FREE:        'Free',
  PRO:         'Pro',
  PRO_TRACKER: 'Pro+Tracker',
  ENTERPRISE:  'Enterprise',
}

function fmtDate(d: Date | null | undefined) {
  if (!d) return '—'
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Europe/Madrid' })
}

function daysLeft(d: Date | null) {
  if (!d) return null
  const diff = d.getTime() - Date.now()
  if (diff <= 0) return 0
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

export default async function AdminUsersPage({ searchParams }: PageProps) {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) redirect('/login')

  const dbUser = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } })
  if (!dbUser?.isAdmin) redirect('/dashboard')

  const params      = await searchParams
  const filterPlan  = typeof params['plan'] === 'string' ? params['plan']  : undefined
  const filterTg    = typeof params['tg']   === 'string' ? params['tg']    : undefined
  const filterFrom  = typeof params['from'] === 'string' ? params['from']  : undefined
  const filterTo    = typeof params['to']   === 'string' ? params['to']    : undefined
  const filterQ     = typeof params['q']    === 'string' ? params['q']     : undefined

  const where: Prisma.UserWhereInput = {
    ...(filterPlan ? { plan: filterPlan as never } : {}),
    ...(filterTg === 'yes' ? { telegramId: { not: null } } : {}),
    ...(filterTg === 'no'  ? { telegramId: null }          : {}),
    ...(filterQ ? {
      OR: [
        { name:  { contains: filterQ, mode: 'insensitive' } },
        { email: { contains: filterQ, mode: 'insensitive' } },
      ],
    } : {}),
    ...(filterFrom || filterTo ? {
      createdAt: {
        ...(filterFrom ? { gte: new Date(`${filterFrom}T00:00:00`) } : {}),
        ...(filterTo   ? { lte: new Date(`${filterTo}T23:59:59`)   } : {}),
      },
    } : {}),
  }

  const [users, totalUsers, proCount, freeCount, tgCount] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true, name: true, email: true,
        plan: true, planExpiresAt: true, isAdmin: true, hasEverPaid: true,
        telegramId: true, telegramUsername: true,
        createdAt: true, lastLoginAt: true,
        _count: { select: { betRecords: { where: { deletedAt: null } } } },
      },
    }),
    prisma.user.count(),
    prisma.user.count({ where: { plan: { not: 'FREE' } } }),
    prisma.user.count({ where: { plan: 'FREE' } }),
    prisma.user.count({ where: { telegramId: { not: null } } }),
  ])

  // Build CSV export URL with current filters
  const csvParams = new URLSearchParams()
  if (filterPlan) csvParams.set('plan', filterPlan)
  if (filterTg)   csvParams.set('tg',   filterTg)
  if (filterFrom) csvParams.set('from', filterFrom)
  if (filterTo)   csvParams.set('to',   filterTo)

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-xs font-bold bg-amber-100 text-amber-700 border border-amber-200 px-2 py-0.5 rounded uppercase tracking-wide">Admin</span>
            <h1 className="text-2xl font-bold tracking-tight">Usuarios</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {users.length} resultados · {totalUsers} usuarios totales
          </p>
        </div>
        <a
          href={`/api/admin/users/export?${csvParams.toString()}`}
          className="shrink-0 flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          📥 Exportar CSV
        </a>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total usuarios', value: totalUsers },
          { label: 'Planes activos', value: proCount   },
          { label: 'Plan Free',      value: freeCount  },
          { label: 'Con Telegram',   value: tgCount    },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl border bg-card px-4 py-3 shadow-sm">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold text-foreground leading-tight mt-0.5">{value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          {/* Search */}
          <div className="space-y-1 flex-1 min-w-[160px]">
            <label className="text-xs font-medium text-muted-foreground">Buscar</label>
            <input
              name="q"
              defaultValue={filterQ ?? ''}
              placeholder="nombre o email…"
              className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Plan */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Plan</label>
            <select
              name="plan"
              defaultValue={filterPlan ?? ''}
              className="rounded-lg border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Todos</option>
              <option value="FREE">Free</option>
              <option value="PRO">Pro</option>
              <option value="PRO_TRACKER">Pro+Tracker</option>
              <option value="ENTERPRISE">Enterprise</option>
            </select>
          </div>

          {/* Telegram */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Telegram</label>
            <select
              name="tg"
              defaultValue={filterTg ?? ''}
              className="rounded-lg border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Todos</option>
              <option value="yes">Vinculado</option>
              <option value="no">Sin vincular</option>
            </select>
          </div>

          {/* Date range */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Registro desde</label>
            <input
              type="date" name="from"
              defaultValue={filterFrom ?? ''}
              className="rounded-lg border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Hasta</label>
            <input
              type="date" name="to"
              defaultValue={filterTo ?? ''}
              className="rounded-lg border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <button
            type="submit"
            className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            Filtrar
          </button>
          {(filterPlan ?? filterTg ?? filterFrom ?? filterTo ?? filterQ) && (
            <a href="/admin/users" className="px-3 py-1.5 rounded-lg border text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              Limpiar
            </a>
          )}
        </form>
      </div>

      {/* Table */}
      {users.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <p className="text-3xl mb-3">👥</p>
          <p className="font-semibold">Sin resultados</p>
          <p className="text-sm text-muted-foreground mt-1">Prueba con otros filtros.</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block rounded-xl border shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Usuario</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Plan</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden lg:table-cell">Expira</th>
                  <th className="text-center px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Telegram</th>
                  <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden lg:table-cell">Ops.</th>
                  <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Registro</th>
                  <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden xl:table-cell">Último login</th>
                  <th className="px-4 py-3 text-xs uppercase tracking-wide"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {users.map((u) => {
                  const dl        = daysLeft(u.planExpiresAt)
                  const expiring  = dl !== null && dl <= 3 && dl > 0
                  const expired   = dl !== null && dl === 0

                  return (
                    <tr key={u.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {u.isAdmin && (
                            <span className="text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded uppercase">ADM</span>
                          )}
                          <div>
                            <p className="text-xs font-semibold">{u.name ?? '—'}</p>
                            <p className="text-xs text-muted-foreground">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center text-xs font-semibold rounded-full px-2.5 py-0.5 ${PLAN_BADGE[u.plan] ?? 'bg-gray-100 text-gray-500'}`}>
                          {PLAN_LABEL[u.plan] ?? u.plan}
                        </span>
                        {u.hasEverPaid && (
                          <span className="ml-1 text-[10px] text-green-600 font-medium">✓ pagó</span>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {u.planExpiresAt ? (
                          <span className={`text-xs ${expired ? 'text-red-600 font-semibold' : expiring ? 'text-amber-600 font-medium' : 'text-muted-foreground'}`}>
                            {fmtDate(u.planExpiresAt)}
                            {dl !== null && dl > 0 && <span className="ml-1 text-[10px]">({dl}d)</span>}
                            {expired && <span className="ml-1 text-[10px]">(vencido)</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/50">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {u.telegramId ? (
                          <span className="text-xs text-blue-600 font-medium">
                            ✅{u.telegramUsername ? ` @${u.telegramUsername}` : ''}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/50">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right hidden lg:table-cell">
                        <span className="text-xs font-mono">{u._count.betRecords}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                        {fmtDate(u.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-muted-foreground hidden xl:table-cell">
                        {fmtDate(u.lastLoginAt)}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/settings?tab=admin&uid=${u.id}`}
                          className="text-[11px] text-primary hover:underline font-medium"
                        >
                          Gestionar →
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {users.map((u) => {
              const dl = daysLeft(u.planExpiresAt)
              return (
                <div key={u.id} className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {u.isAdmin && (
                          <span className="text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded uppercase">ADM</span>
                        )}
                        <p className="text-sm font-semibold truncate">{u.name ?? '—'}</p>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                    </div>
                    <span className={`shrink-0 inline-flex items-center text-xs font-semibold rounded-full px-2.5 py-0.5 ${PLAN_BADGE[u.plan] ?? 'bg-gray-100 text-gray-500'}`}>
                      {PLAN_LABEL[u.plan] ?? u.plan}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>📅 {fmtDate(u.createdAt)}</span>
                    <span>📋 {u._count.betRecords} ops</span>
                    {u.telegramId && <span className="text-blue-600">✅ Telegram</span>}
                    {u.planExpiresAt && dl !== null && (
                      <span className={dl <= 3 ? 'text-amber-600 font-medium' : ''}>
                        Expira: {fmtDate(u.planExpiresAt)} {dl > 0 ? `(${dl}d)` : '(vencido)'}
                      </span>
                    )}
                  </div>
                  <Link
                    href={`/settings?tab=admin&uid=${u.id}`}
                    className="inline-flex items-center text-xs text-primary hover:underline font-medium"
                  >
                    Gestionar →
                  </Link>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
