'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { settleBetAction } from '@/lib/actions/bet-record'

export interface LegInfo {
  id:             string
  bookmakerId:    string
  bookmakerName:  string
  stake:          number
  odds:           number
  potentialReturn: number
}

export interface BetForSettle {
  id:                  string
  type:                string
  totalStake:          number
  primaryBookmakerId:  string | null
  singleOdds:          number | null
  legs:                LegInfo[]
}

interface Props {
  bet: BetForSettle
}

const SETTLED_LABELS: Record<string, { text: string; cls: string }> = {
  WON:     { text: '✅ Ganada',    cls: 'text-green-600' },
  LOST:    { text: '❌ Perdida',   cls: 'text-red-600'   },
  VOID:    { text: '↩ Anulada',   cls: 'text-gray-500'  },
  CASHOUT: { text: '💰 Cashout',  cls: 'text-blue-600'  },
}

export function SettleButton({ bet }: Props) {
  const [open, setOpen]       = useState(false)
  const [settled, setSettled] = useState<string | null>(null)

  // Actualización optimista: muestra el nuevo estado INMEDIATAMENTE
  // sin esperar a que router.refresh() complete
  if (settled) {
    const meta = SETTLED_LABELS[settled]
    return (
      <span className={`text-xs font-medium ${meta?.cls ?? 'text-muted-foreground'}`}>
        {meta?.text ?? settled}
      </span>
    )
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
      >
        Liquidar
      </button>
      {open && (
        <SettleModal
          bet={bet}
          onClose={() => setOpen(false)}
          onSettled={setSettled}
        />
      )}
    </>
  )
}

// ─── Modal ───────────────────────────────────────────────────────────────────

type Outcome = 'WON' | 'LOST' | 'VOID' | 'CASHOUT'
type WinningLeg = '1' | '2' | 'BOTH'

function SettleModal({ bet, onClose, onSettled }: { bet: BetForSettle; onClose: () => void; onSettled: (status: string) => void }) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const isMultiLeg  = bet.type === 'ARBITRAGE' || bet.type === 'MIDDLE'
  const leg1 = bet.legs[0]
  const leg2 = bet.legs[1]

  const [outcome, setOutcome]     = useState<Outcome>('WON')
  const [winLeg, setWinLeg]       = useState<WinningLeg>('1')
  const [cashout, setCashout]     = useState('')
  const [isPending, setIsPending] = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [success, setSuccess]     = useState(false)

  // ── Profit preview ──────────────────────────────────────────────────────────
  function calcPreview(): number {
    if (isMultiLeg && leg1 && leg2) {
      if (bet.type === 'MIDDLE' && winLeg === 'BOTH') {
        return leg1.potentialReturn + leg2.potentialReturn - bet.totalStake
      }
      const winReturn = winLeg === '1' ? (leg1.potentialReturn) : (leg2.potentialReturn)
      return winReturn - bet.totalStake
    }
    if (outcome === 'VOID') return 0
    if (outcome === 'CASHOUT') return parseFloat(cashout || '0') - bet.totalStake
    if (outcome === 'WON') return bet.totalStake * ((bet.singleOdds ?? 2) - 1)
    return -bet.totalStake
  }

  const preview       = calcPreview()
  const previewColor  = preview > 0 ? 'text-green-600' : preview < 0 ? 'text-red-600' : 'text-muted-foreground'
  const previewSign   = preview >= 0 ? '+' : ''

  async function handleSubmit() {
    setError(null)
    setIsPending(true)

    const fd = new FormData()
    fd.append('betRecordId', bet.id)
    fd.append('outcome', isMultiLeg ? (preview >= 0 ? 'WON' : 'LOST') : outcome)
    if (isMultiLeg)                     fd.append('winningLeg', winLeg)
    if (outcome === 'CASHOUT')          fd.append('cashoutAmount', cashout)

    const result = await settleBetAction(fd)
    setIsPending(false)

    if (result.success) {
      const finalStatus = isMultiLeg ? (preview >= 0 ? 'WON' : 'LOST') : outcome
      setSuccess(true)
      onSettled(finalStatus)          // actualización optimista instantánea
      startTransition(() => router.refresh())
      setTimeout(onClose, 1400)
    } else {
      setError(result.error)
    }
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  const typeLabel = bet.type === 'ARBITRAGE' ? 'Surebets' : bet.type === 'MIDDLE' ? 'Middlebet' : bet.type

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={handleBackdrop}>
      <div className="bg-card border rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">

        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Liquidar operación</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors">×</button>
        </div>

        {success ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <span className="text-4xl">✅</span>
            <p className="font-semibold">¡Operación liquidada!</p>
          </div>
        ) : (
          <>
            {/* Info summary */}
            <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs space-y-1">
              <p><span className="text-muted-foreground">Tipo:</span> {typeLabel}</p>
              <p><span className="text-muted-foreground">Stake total:</span> {bet.totalStake.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}</p>
            </div>

            {error && (
              <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
            )}

            {/* Settlement options */}
            {isMultiLeg ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">¿Qué pierna ganó?</p>
                {leg1 && (
                  <LegOption
                    label={`Leg 1 — ${leg1.bookmakerName}`}
                    subtext={`@${leg1.odds.toFixed(2)} · retorno: ${leg1.potentialReturn.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`}
                    checked={winLeg === '1'}
                    onChange={() => setWinLeg('1')}
                  />
                )}
                {leg2 && (
                  <LegOption
                    label={`Leg 2 — ${leg2.bookmakerName}`}
                    subtext={`@${leg2.odds.toFixed(2)} · retorno: ${leg2.potentialReturn.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`}
                    checked={winLeg === '2'}
                    onChange={() => setWinLeg('2')}
                  />
                )}
                {bet.type === 'MIDDLE' && (
                  <LegOption
                    label="✨ ¡Middle hit! — Ambas ganaron"
                    subtext="Se reciben ambos retornos"
                    checked={winLeg === 'BOTH'}
                    onChange={() => setWinLeg('BOTH')}
                  />
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">Resultado</p>
                <div className="grid grid-cols-3 gap-2">
                  {(['WON', 'LOST', 'VOID'] as Outcome[]).map((o) => {
                    const labels: Record<Outcome, string> = { WON: '✅ Ganada', LOST: '❌ Perdida', VOID: '↩ Anulada', CASHOUT: '💰 Cashout' }
                    const cls: Record<Outcome, string>    = {
                      WON:    outcome === 'WON'  ? 'bg-green-600 text-white border-green-600' : 'border-border text-muted-foreground hover:border-green-400',
                      LOST:   outcome === 'LOST' ? 'bg-red-600 text-white border-red-600'     : 'border-border text-muted-foreground hover:border-red-400',
                      VOID:   outcome === 'VOID' ? 'bg-gray-500 text-white border-gray-500'   : 'border-border text-muted-foreground hover:border-gray-400',
                      CASHOUT: '',
                    }
                    return (
                      <button key={o} type="button" onClick={() => setOutcome(o)}
                        className={`text-xs py-2 px-2 rounded-lg border font-medium transition-colors ${cls[o]}`}>
                        {labels[o]}
                      </button>
                    )
                  })}
                </div>
                <button type="button" onClick={() => setOutcome('CASHOUT')}
                  className={`w-full text-xs py-2 px-3 rounded-lg border font-medium transition-colors ${outcome === 'CASHOUT' ? 'bg-blue-600 text-white border-blue-600' : 'border-border text-muted-foreground hover:border-blue-400'}`}>
                  💰 Cashout
                </button>
                {outcome === 'CASHOUT' && (
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Importe recibido (€)</label>
                    <input type="number" step="0.01" min="0" value={cashout} onChange={(e) => setCashout(e.target.value)}
                      placeholder="ej. 85.00"
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
                  </div>
                )}
              </div>
            )}

            {/* Profit preview */}
            <div className="rounded-lg bg-muted/30 border px-3 py-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">P&L estimado</span>
              <span className={`text-sm font-bold tabular-nums ${previewColor}`}>
                {previewSign}{preview.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
              </span>
            </div>

            <button
              onClick={handleSubmit}
              disabled={isPending}
              className="w-full rounded-lg bg-primary text-primary-foreground py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {isPending ? 'Liquidando...' : 'Confirmar liquidación'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function LegOption({ label, subtext, checked, onChange }: { label: string; subtext: string; checked: boolean; onChange: () => void }) {
  return (
    <button type="button" onClick={onChange}
      className={`w-full text-left text-xs rounded-lg border px-3 py-2.5 transition-colors ${checked ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40'}`}>
      <p className="font-medium">{label}</p>
      <p className="opacity-70 mt-0.5">{subtext}</p>
    </button>
  )
}
