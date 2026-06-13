'use client'

import { useState, useTransition } from 'react'
import { saveMonthlyGoalAction } from '@/lib/actions/settings'

interface Props {
  target:  number
  current: number
}

export function MonthlyGoalWidget({ target, current }: Props) {
  const [editing,  setEditing]  = useState(false)
  const [inputVal, setInputVal] = useState(String(target))
  const [pending,  start]       = useTransition()
  const [error,    setError]    = useState<string | null>(null)

  const pct      = target > 0 ? Math.min(100, (current / target) * 100) : 0
  const reached  = current >= target
  const behind   = current < 0
  const sign     = current >= 0 ? '+' : ''
  const fmtEur   = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 })

  function handleSave() {
    const val = parseFloat(inputVal.replace(',', '.'))
    if (isNaN(val) || val < 0) { setError('Introduce un número positivo'); return }
    setError(null)
    start(async () => {
      await saveMonthlyGoalAction(val)
      setEditing(false)
    })
  }

  function handleClear() {
    start(async () => {
      await saveMonthlyGoalAction(null)
    })
  }

  const barColor = reached ? 'bg-green-500' : behind ? 'bg-red-500' : 'bg-primary'

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Objetivo mensual</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            P&L acumulado este mes
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!editing ? (
            <>
              <button
                onClick={() => setEditing(true)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                title="Cambiar objetivo"
              >
                ✏️
              </button>
              <button
                onClick={handleClear}
                disabled={pending}
                className="text-xs text-muted-foreground hover:text-red-500 transition-colors"
                title="Eliminar objetivo"
              >
                ✕
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="decimal"
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                className="w-24 rounded-lg border bg-background px-2.5 py-1 text-sm text-right outline-none focus:ring-2 focus:ring-ring"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false) }}
              />
              <span className="text-xs text-muted-foreground">€</span>
              <button
                onClick={handleSave}
                disabled={pending}
                className="text-xs bg-primary text-primary-foreground px-2 py-1 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                OK
              </button>
              <button onClick={() => setEditing(false)} className="text-xs text-muted-foreground hover:text-foreground">✕</button>
            </div>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-end justify-between gap-2">
        <div>
          <span className={`text-2xl font-bold tabular-nums ${reached ? 'text-green-600' : behind ? 'text-red-600' : 'text-foreground'}`}>
            {sign}{fmtEur(current)}
          </span>
          <span className="text-sm text-muted-foreground ml-1.5">de {fmtEur(target)}</span>
        </div>
        <span className={`text-sm font-semibold tabular-nums ${reached ? 'text-green-600' : 'text-muted-foreground'}`}>
          {reached ? '🎯 ¡Conseguido!' : `${pct.toFixed(0)}%`}
        </span>
      </div>

      <div className="h-2.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${Math.max(0, pct)}%` }}
        />
      </div>

      {!reached && target > 0 && (
        <p className="text-xs text-muted-foreground">
          {current >= 0
            ? `Faltan ${fmtEur(target - current)} para el objetivo`
            : `${fmtEur(Math.abs(current))} en negativo — necesitas ${fmtEur(target - current)} más`}
        </p>
      )}
    </div>
  )
}
