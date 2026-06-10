'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { confirmDraftAction } from '@/lib/actions/bet-record'

export interface DraftBet {
  id:         string
  type:       string
  sport:      string | null
  title:      string | null
  totalStake: number
  datePlaced: string
  legs: Array<{
    id:    string
    stake: number
    odds:  number
    bookmaker: {
      id:             string
      name:           string
      etiqueta:       string | null
      initialCapital: number | null
    }
  }>
}

interface Props {
  drafts: DraftBet[]
}

export function PendientesSection({ drafts }: Props) {
  if (drafts.length === 0) return null

  return (
    <div className="space-y-3">
      {/* Banner */}
      <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 px-4 py-3 flex items-start gap-3">
        <span className="text-xl mt-0.5">⚠️</span>
        <div className="text-sm flex-1 min-w-0">
          <p className="font-semibold text-amber-800 dark:text-amber-300">
            {drafts.length === 1
              ? '1 apuesta pendiente de confirmar'
              : `${drafts.length} apuestas pendientes de confirmar`}
          </p>
          <p className="text-amber-700 dark:text-amber-400 text-xs mt-0.5">
            Las siguientes operaciones llegaron del bot pero no se procesaron porque alguna casa no tiene capital inicial registrado.
            Registra el capital en <a href="/bookmakers" className="underline font-semibold hover:no-underline">Casas de Apuestas</a> y luego confirma cada apuesta.
          </p>
        </div>
      </div>

      {/* Draft cards */}
      <div className="space-y-2">
        {drafts.map((draft) => (
          <DraftCard key={draft.id} draft={draft} />
        ))}
      </div>
    </div>
  )
}

function DraftCard({ draft }: { draft: DraftBet }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busy,  setBusy]  = useState(false)
  const [error, setError] = useState<string | null>(null)

  const missingBookmakers = draft.legs
    .filter((l) => l.bookmaker.initialCapital === null)
    .map((l) => l.bookmaker.etiqueta ? `${l.bookmaker.name} · ${l.bookmaker.etiqueta}` : l.bookmaker.name)
    .filter((name, i, arr) => arr.indexOf(name) === i)

  const canConfirm = missingBookmakers.length === 0

  const fmt      = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })
  const dateStr  = new Date(draft.datePlaced).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
  const typeLabel = draft.type === 'ARBITRAGE' ? 'Surebet' : 'Middlebet'

  async function handleConfirm() {
    setBusy(true)
    setError(null)
    const res = await confirmDraftAction([draft.id])
    setBusy(false)
    if (res.success) {
      startTransition(() => router.refresh())
    } else {
      setError(res.error)
    }
  }

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        {/* Info */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold uppercase tracking-wide bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 px-2 py-0.5 rounded-full">
              Borrador
            </span>
            <span className="text-xs text-muted-foreground font-medium">{typeLabel}</span>
            <span className="text-xs text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">{dateStr}</span>
          </div>
          <p className="text-sm font-semibold mt-1 truncate">{draft.title ?? typeLabel}</p>

          {/* Legs summary */}
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {draft.legs.map((leg) => {
              const missing = leg.bookmaker.initialCapital === null
              const bmName  = leg.bookmaker.etiqueta
                ? `${leg.bookmaker.name} · ${leg.bookmaker.etiqueta}`
                : leg.bookmaker.name
              return (
                <span
                  key={leg.id}
                  className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                    missing
                      ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/20 dark:text-red-400 dark:border-red-800'
                      : 'bg-muted/60 text-muted-foreground border-transparent'
                  }`}
                >
                  {missing && <span>!</span>}
                  {bmName} · @{leg.odds.toFixed(2)} · {fmt(leg.stake)}
                </span>
              )
            })}
          </div>
        </div>

        {/* Stake + confirm */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          <p className="text-sm font-bold tabular-nums">{fmt(draft.totalStake)}</p>
          <button
            onClick={handleConfirm}
            disabled={busy || !canConfirm}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {busy ? 'Confirmando...' : 'Confirmar'}
          </button>
        </div>
      </div>

      {/* Missing capital warning */}
      {missingBookmakers.length > 0 && (
        <div className="rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          Sin capital inicial: <span className="font-semibold">{missingBookmakers.join(', ')}</span>.{' '}
          <a href="/bookmakers" className="underline hover:no-underline">Registrarlo →</a>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
      )}
    </div>
  )
}
