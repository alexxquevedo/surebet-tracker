'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { activateProAction, revokeProAction, toggleAdminAction } from '@/lib/actions/admin'

interface UserActionsProps {
  userId:  string
  plan:    string
  isAdmin: boolean
}

const isPro = (plan: string) => ['PRO', 'PRO_TRACKER', 'ENTERPRISE'].includes(plan)

export function UserActions({ userId, plan, isAdmin }: UserActionsProps) {
  const router = useRouter()
  const [days,     setDays]     = useState('30')
  const [planType, setPlanType] = useState<'PRO' | 'PRO_TRACKER'>('PRO')
  const [msg,      setMsg]      = useState<string | null>(null)
  const [ok,       setOk]       = useState(true)
  const [pending,  start]       = useTransition()

  function flash(text: string, success: boolean) {
    setMsg(text)
    setOk(success)
    setTimeout(() => setMsg(null), 3000)
  }

  function handleActivate() {
    start(async () => {
      const r = await activateProAction(userId, parseInt(days, 10) || 30, planType)
      flash(r.success ? r.message : r.error, r.success)
      if (r.success) router.refresh()
    })
  }

  function handleRevoke() {
    if (!confirm('¿Revocar PRO de este usuario?')) return
    start(async () => {
      const r = await revokeProAction(userId)
      flash(r.success ? r.message : r.error, r.success)
      if (r.success) router.refresh()
    })
  }

  function handleToggleAdmin() {
    if (!confirm(isAdmin ? '¿Quitar admin?' : '¿Hacer admin?')) return
    start(async () => {
      const r = await toggleAdminAction(userId, !isAdmin)
      flash(r.success ? r.message : r.error, r.success)
      if (r.success) router.refresh()
    })
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 flex-wrap">
        <select
          value={planType}
          onChange={(e) => setPlanType(e.target.value as 'PRO' | 'PRO_TRACKER')}
          className="rounded border bg-background px-1 py-0.5 text-[10px]"
        >
          <option value="PRO">Pro</option>
          <option value="PRO_TRACKER">Pro+Tracker</option>
        </select>
        <input
          type="number" min={1} max={365}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className="w-10 rounded border bg-background px-1 py-0.5 text-[10px] text-center"
          title="Días"
        />
        <span className="text-[10px] text-muted-foreground">d</span>
        <button
          onClick={handleActivate} disabled={pending}
          className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isPro(plan) ? '+' : '▶'}
        </button>
        {isPro(plan) && (
          <button
            onClick={handleRevoke} disabled={pending}
            className="rounded border border-red-300 px-1.5 py-0.5 text-[10px] text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            ✕
          </button>
        )}
        <button
          onClick={handleToggleAdmin} disabled={pending}
          title={isAdmin ? 'Quitar admin' : 'Hacer admin'}
          className={`rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-50 ${
            isAdmin
              ? 'border-amber-300 bg-amber-50 text-amber-600 hover:bg-amber-100'
              : 'border-gray-200 text-gray-400 hover:border-amber-300 hover:text-amber-500'
          }`}
        >
          👑
        </button>
      </div>
      {msg && (
        <p className={`text-[10px] ${ok ? 'text-green-600' : 'text-red-500'}`}>{msg}</p>
      )}
    </div>
  )
}
