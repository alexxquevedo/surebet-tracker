'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { addPresetBookmakerAction } from '@/lib/actions/bookmaker'
import { BOOKMAKER_PRESETS, type BookmakerPreset } from '@/lib/utils/bookmakers-preset'

interface Props {
  existingNames: string[]
}

export function AddBookmakerModal({ existingNames }: Props) {
  const [open, setOpen] = useState(false)
  const available = BOOKMAKER_PRESETS.filter((p) => !existingNames.includes(p.name))

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:bg-primary/90 transition-colors shadow-sm"
      >
        + Añadir casa
      </button>
      {open && <Modal available={available} onClose={() => setOpen(false)} />}
    </>
  )
}

function Modal({ available, onClose }: { available: BookmakerPreset[]; onClose: () => void }) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [selected, setSelected]     = useState<BookmakerPreset | null>(null)
  const [balance, setBalance]       = useState('')
  const [isPending, setIsPending]   = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [success, setSuccess]       = useState(false)

  async function handleAdd() {
    if (!selected) return
    setError(null)
    setIsPending(true)
    const initialBalance = parseFloat(balance || '0')
    if (isNaN(initialBalance) || initialBalance < 0) {
      setError('Saldo inicial inválido')
      setIsPending(false)
      return
    }
    const result = await addPresetBookmakerAction(selected, initialBalance)
    setIsPending(false)
    if (result.success) {
      setSuccess(true)
      startTransition(() => router.refresh())
      setTimeout(onClose, 1200)
    } else {
      setError(result.error)
    }
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={handleBackdrop}>
      <div className="bg-card border rounded-xl shadow-xl w-full max-w-md p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Añadir Casa de Apuestas</h2>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted transition-colors text-xl">×</button>
        </div>

        {success ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <span className="text-5xl">🏦</span>
            <p className="font-semibold text-lg">¡Casa añadida!</p>
          </div>
        ) : (
          <>
            {error && (
              <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium">Selecciona una casa</p>
              {available.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">Ya tienes todas las casas disponibles.</p>
              ) : (
                <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
                  {available.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => setSelected(p)}
                      className={`flex items-center gap-2.5 text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                        selected?.name === p.name
                          ? 'border-primary bg-primary/10 text-primary font-medium'
                          : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
                      }`}
                    >
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                      <span className="truncate">{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selected && (
              <div className="space-y-2">
                <label htmlFor="bm-balance" className="block text-sm font-medium">
                  Saldo inicial en {selected.name} (€)
                </label>
                <input
                  id="bm-balance"
                  type="number"
                  step="0.01"
                  min="0"
                  value={balance}
                  onChange={(e) => setBalance(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">
                  Puedes dejarlo en 0 si aún no has depositado.
                </p>
              </div>
            )}

            <button
              onClick={handleAdd}
              disabled={isPending || !selected}
              className="w-full rounded-md bg-primary text-primary-foreground px-3 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isPending ? 'Añadiendo...' : selected ? `Añadir ${selected.name}` : 'Selecciona una casa'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
