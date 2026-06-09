'use client'

import { useState, useTransition } from 'react'
import { activateProAction, revokeProAction, getAdminDataAction, toggleAdminAction } from '@/lib/actions/admin'
import type { AdminStats, AdminUser } from '@/lib/actions/admin'

interface AdminTabProps {
  initialStats: AdminStats
  initialUsers: AdminUser[]
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

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' })
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-xl font-bold text-foreground leading-tight">{value}</p>
    </div>
  )
}

export function AdminTab({ initialStats, initialUsers }: AdminTabProps) {
  const [stats, setStats]   = useState(initialStats)
  const [users, setUsers]   = useState(initialUsers)
  const [msg,   setMsg]     = useState<{ text: string; ok: boolean } | null>(null)
  const [customDays, setCustomDays]   = useState<Record<string, string>>({})
  const [planType,   setPlanType]     = useState<Record<string, 'PRO' | 'PRO_TRACKER'>>({})
  const [isPending, startTransition]  = useTransition()

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
    const plan = planType[userId] ?? 'PRO'
    startTransition(async () => {
      const r = await activateProAction(userId, days, plan)
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
    if (!confirm(makeAdmin ? '¿Hacer admin?' : '¿Quitar admin?')) return
    startTransition(async () => {
      const r = await toggleAdminAction(userId, makeAdmin)
      if (r.success) { showMsg(r.message, true); await refresh() }
      else             showMsg(r.error, false)
    })
  }

  const isPro = (plan: string) => plan === 'PRO' || plan === 'PRO_TRACKER' || plan === 'ENTERPRISE'

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Panel de administración</h2>
        <p className="text-sm text-muted-foreground mt-0.5">Gestión de usuarios y suscripciones</p>
      </div>

      {msg && (
        <div className={`rounded-md px-3 py-2 text-sm ${msg.ok ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {msg.text}
        </div>
      )}

      {/* Stats — 4 + 2 compactos */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <StatCard label="Usuarios"    value={stats.totalUsers}   />
        <StatCard label="PRO"         value={stats.proUsers}     />
        <StatCard label="Free"        value={stats.freeUsers}    />
        <StatCard label="Apuestas"    value={stats.totalBets}    />
        <StatCard label="Esta semana" value={stats.newThisWeek}  />
        <StatCard label="Este mes"    value={stats.newThisMonth} />
      </div>

      {/* Tabla compacta — sin scroll horizontal */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">Usuarios ({stats.totalUsers})</h3>
          <button
            onClick={() => startTransition(refresh)}
            disabled={isPending}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {isPending ? '…' : '↻ Refrescar'}
          </button>
        </div>

        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/50 text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Usuario</th>
                <th className="px-3 py-2 text-left font-medium">Plan · Expira</th>
                <th className="px-2 py-2 text-center font-medium">Bets</th>
                <th className="px-2 py-2 text-center font-medium">TG</th>
                <th className="px-3 py-2 text-right font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-muted/20 transition-colors">

                  {/* Usuario */}
                  <td className="px-3 py-2 max-w-[160px]">
                    <div className="font-medium truncate">{u.name ?? '—'}</div>
                    <div className="text-muted-foreground truncate text-[11px]">{u.email}</div>
                    {u.isAdmin && <span className="text-[10px] text-amber-600 font-medium">👑 admin</span>}
                  </td>

                  {/* Plan + expiry */}
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${PLAN_BADGE[u.plan] ?? PLAN_BADGE.FREE}`}>
                      {PLAN_LABEL[u.plan] ?? u.plan}
                    </span>
                    {isPro(u.plan) && u.daysLeft !== null && (
                      <div className={`text-[11px] mt-0.5 ${u.daysLeft <= 3 ? 'text-red-600 font-medium' : u.daysLeft <= 7 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                        {u.daysLeft}d · {fmtDate(u.planExpiresAt)}
                      </div>
                    )}
                  </td>

                  {/* Bets */}
                  <td className="px-2 py-2 text-center font-mono">{u.betCount}</td>

                  {/* Telegram */}
                  <td className="px-2 py-2 text-center">{u.telegramLinked ? '✅' : '—'}</td>

                  {/* Acciones */}
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {/* Selector plan */}
                      <select
                        value={planType[u.id] ?? 'PRO'}
                        onChange={(e) => setPlanType((p) => ({ ...p, [u.id]: e.target.value as 'PRO' | 'PRO_TRACKER' }))}
                        className="rounded border bg-background px-1 py-0.5 text-[10px]"
                      >
                        <option value="PRO">Pro</option>
                        <option value="PRO_TRACKER">Pro+Tracker</option>
                      </select>
                      {/* Días */}
                      <input
                        type="number"
                        min={1} max={365}
                        value={customDays[u.id] ?? '30'}
                        onChange={(e) => setCustomDays((p) => ({ ...p, [u.id]: e.target.value }))}
                        className="w-10 rounded border bg-background px-1 py-0.5 text-[10px] text-center"
                        title="Días"
                      />
                      <span className="text-[10px] text-muted-foreground">d</span>
                      {/* Activar */}
                      <button
                        onClick={() => handleActivate(u.id)}
                        disabled={isPending}
                        className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {isPro(u.plan) ? '+' : '▶'}
                      </button>
                      {/* Revocar */}
                      {isPro(u.plan) && (
                        <button
                          onClick={() => handleRevoke(u.id)}
                          disabled={isPending}
                          className="rounded border border-red-300 px-1.5 py-0.5 text-[10px] text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          ✕
                        </button>
                      )}
                      {/* Toggle admin */}
                      <button
                        onClick={() => handleToggleAdmin(u.id, !u.isAdmin)}
                        disabled={isPending}
                        title={u.isAdmin ? 'Quitar admin' : 'Hacer admin'}
                        className={`rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-50 ${
                          u.isAdmin
                            ? 'border-amber-300 bg-amber-50 text-amber-600 hover:bg-amber-100'
                            : 'border-gray-200 text-gray-400 hover:border-amber-300 hover:text-amber-500'
                        }`}
                      >
                        👑
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
