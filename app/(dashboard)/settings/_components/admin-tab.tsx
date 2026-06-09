'use client'

import { useState, useTransition } from 'react'
import { activateProAction, revokeProAction, getAdminDataAction, toggleAdminAction } from '@/lib/actions/admin'
import type { AdminStats, AdminUser } from '@/lib/actions/admin'

interface AdminTabProps {
  initialStats: AdminStats
  initialUsers: AdminUser[]
}

const PLAN_BADGE: Record<string, string> = {
  FREE:       'bg-gray-100 text-gray-600 border border-gray-200',
  PRO:        'bg-blue-100 text-blue-700 border border-blue-200',
  ENTERPRISE: 'bg-purple-100 text-purple-700 border border-purple-200',
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' })
}

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-bold text-foreground">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

export function AdminTab({ initialStats, initialUsers }: AdminTabProps) {
  const [stats, setStats]   = useState(initialStats)
  const [users, setUsers]   = useState(initialUsers)
  const [msg,   setMsg]     = useState<{ text: string; ok: boolean } | null>(null)
  const [customDays, setCustomDays] = useState<Record<string, string>>({})
  const [isPending, startTransition] = useTransition()

  function showMsg(text: string, ok: boolean) {
    setMsg({ text, ok })
    setTimeout(() => setMsg(null), 4000)
  }

  async function refresh() {
    const r = await getAdminDataAction()
    if (r.success) { setStats(r.stats); setUsers(r.users) }
  }

  function handleActivate(userId: string) {
    const days = parseInt(customDays[userId] ?? '30', 10) || 30
    startTransition(async () => {
      const r = await activateProAction(userId, days)
      if (r.success) { showMsg(r.message, true); await refresh() }
      else             showMsg(r.error, false)
    })
  }

  function handleRevoke(userId: string) {
    if (!confirm('¿Revocar PRO de este usuario?')) return
    startTransition(async () => {
      const r = await revokeProAction(userId)
      if (r.success) { showMsg(r.message, true); await refresh() }
      else             showMsg(r.error, false)
    })
  }

  function handleToggleAdmin(userId: string, makeAdmin: boolean) {
    if (!confirm(makeAdmin ? '¿Hacer admin a este usuario?' : '¿Quitar rol admin?')) return
    startTransition(async () => {
      const r = await toggleAdminAction(userId, makeAdmin)
      if (r.success) { showMsg(r.message, true); await refresh() }
      else             showMsg(r.error, false)
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold">Panel de administración</h2>
        <p className="text-sm text-muted-foreground mt-0.5">Gestión de usuarios y suscripciones</p>
      </div>

      {/* Feedback */}
      {msg && (
        <div className={`rounded-md px-4 py-2.5 text-sm ${msg.ok ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {msg.text}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total usuarios"   value={stats.totalUsers}   />
        <StatCard label="Usuarios PRO"     value={stats.proUsers}     />
        <StatCard label="Usuarios Free"    value={stats.freeUsers}    />
        <StatCard label="Apuestas totales" value={stats.totalBets}    />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Nuevos esta semana" value={stats.newThisWeek}  />
        <StatCard label="Nuevos este mes"    value={stats.newThisMonth} />
      </div>

      {/* Users table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">Usuarios ({stats.totalUsers})</h3>
          <button
            onClick={() => startTransition(refresh)}
            disabled={isPending}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {isPending ? 'Actualizando…' : '↻ Actualizar'}
          </button>
        </div>

        <div className="rounded-lg border overflow-hidden">
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Usuario</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Plan</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Expira</th>
                  <th className="px-4 py-2.5 text-center font-medium text-muted-foreground">Apuestas</th>
                  <th className="px-4 py-2.5 text-center font-medium text-muted-foreground">TG</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Registrado</th>
                  <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {users.map((u) => {
                  const isPro = u.plan === 'PRO' || u.plan === 'ENTERPRISE'
                  return (
                    <tr key={u.id} className="hover:bg-muted/30 transition-colors">
                      {/* Usuario */}
                      <td className="px-4 py-3">
                        <div className="font-medium truncate max-w-[160px]">{u.name ?? '—'}</div>
                        <div className="text-xs text-muted-foreground truncate max-w-[160px]">{u.email}</div>
                        {u.isAdmin && <span className="text-xs font-medium text-amber-600">👑 Admin</span>}
                      </td>
                      {/* Plan */}
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PLAN_BADGE[u.plan] ?? PLAN_BADGE.FREE}`}>
                          {u.plan}
                        </span>
                      </td>
                      {/* Expira */}
                      <td className="px-4 py-3 text-sm">
                        {isPro && u.daysLeft !== null ? (
                          <span className={u.daysLeft <= 3 ? 'text-red-600 font-medium' : u.daysLeft <= 7 ? 'text-amber-600' : 'text-foreground'}>
                            {u.daysLeft}d ({fmtDate(u.planExpiresAt)})
                          </span>
                        ) : '—'}
                      </td>
                      {/* Apuestas */}
                      <td className="px-4 py-3 text-center font-mono text-sm">{u.betCount}</td>
                      {/* Telegram */}
                      <td className="px-4 py-3 text-center text-base">{u.telegramLinked ? '✅' : '—'}</td>
                      {/* Registrado */}
                      <td className="px-4 py-3 text-xs text-muted-foreground">{fmtDate(u.createdAt)}</td>
                      {/* Acciones */}
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Input días */}
                          <input
                            type="number"
                            min={1}
                            max={365}
                            value={customDays[u.id] ?? '30'}
                            onChange={(e) => setCustomDays((p) => ({ ...p, [u.id]: e.target.value }))}
                            className="w-14 rounded border bg-background px-1.5 py-1 text-xs text-center"
                            title="Días de PRO"
                          />
                          <span className="text-xs text-muted-foreground">d</span>
                          {/* Activar / Extender */}
                          <button
                            onClick={() => handleActivate(u.id)}
                            disabled={isPending}
                            className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                          >
                            {isPro ? '+PRO' : 'Activar PRO'}
                          </button>
                          {/* Revocar */}
                          {isPro && (
                            <button
                              onClick={() => handleRevoke(u.id)}
                              disabled={isPending}
                              className="rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
                            >
                              Revocar
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y">
            {users.map((u) => {
              const isPro = u.plan === 'PRO' || u.plan === 'ENTERPRISE'
              return (
                <div key={u.id} className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-sm">{u.name ?? '—'}</p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                      {u.isAdmin && <span className="text-xs font-medium text-amber-600">👑 Admin</span>}
                    </div>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PLAN_BADGE[u.plan] ?? PLAN_BADGE.FREE}`}>
                      {u.plan}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>{u.betCount} apuestas</span>
                    {isPro && u.daysLeft !== null && <span className="font-medium text-foreground">{u.daysLeft}d restantes</span>}
                    <span>{u.telegramLinked ? '✅ TG' : '— TG'}</span>
                  </div>
                  <div className="flex items-center gap-1.5 pt-1">
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={customDays[u.id] ?? '30'}
                      onChange={(e) => setCustomDays((p) => ({ ...p, [u.id]: e.target.value }))}
                      className="w-14 rounded border bg-background px-1.5 py-1 text-xs text-center"
                    />
                    <span className="text-xs text-muted-foreground">d</span>
                    <button
                      onClick={() => handleActivate(u.id)}
                      disabled={isPending}
                      className="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {isPro ? '+PRO' : 'Activar PRO'}
                    </button>
                    {isPro && (
                      <button
                        onClick={() => handleRevoke(u.id)}
                        disabled={isPending}
                        className="rounded border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        Revocar
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
