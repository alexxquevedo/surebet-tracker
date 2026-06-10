'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createBankrollAction, updateBankrollAction, deleteBankrollAction } from '@/lib/actions/bankroll'

// ─── Types ───────────────────────────────────────────────────────────────────

interface BankrollData {
  id:          string
  name:        string
  description: string | null
  color:       string
  _count:      { bookmakers: number }
  totalStaked: number
  totalProfit: number
  totalBets:   number
  activeBets:  number
}

interface Props {
  bankrolls: BankrollData[]
}

// ════════════════════════════════════════════════════════════════════════════
// BankrollManager
// ════════════════════════════════════════════════════════════════════════════

export function BankrollManager({ bankrolls }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<BankrollData | null>(null)

  function refresh() { startTransition(() => router.refresh()) }

  const fmt = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })

  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Bankrolls</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Líneas de negocio independientes para separar la contabilidad</p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90 transition-colors shadow-sm"
        >
          <span>+</span> Nuevo Bankroll
        </button>
      </div>

      {bankrolls.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="text-2xl mb-2">💼</p>
          <p className="text-sm font-semibold">Sin bankrolls</p>
          <p className="text-xs text-muted-foreground mt-1">
            Crea bankrolls para organizar tus casas por estrategia.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {bankrolls.map((br) => {
            const profitCls = br.totalProfit >= 0 ? 'text-green-600' : 'text-red-600'
            return (
              <div key={br.id} className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
                {/* Header row */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className="w-3.5 h-3.5 rounded-full shrink-0 ring-1 ring-black/10"
                      style={{ backgroundColor: br.color }}
                    />
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{br.name}</p>
                      {br.description && (
                        <p className="text-xs text-muted-foreground truncate">{br.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => setEditTarget(br)}
                      title="Editar bankroll"
                      className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:bg-muted transition-colors text-xs"
                    >
                      ✏️
                    </button>
                    {br._count.bookmakers === 0 && (
                      <DeleteButton bankrollId={br.id} name={br.name} onDeleted={refresh} />
                    )}
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 gap-2 pt-1 border-t">
                  <div>
                    <p className="text-xs text-muted-foreground">P&L</p>
                    <p className={`text-sm font-bold tabular-nums mt-0.5 ${profitCls}`}>
                      {br.totalProfit >= 0 ? '+' : ''}{fmt(br.totalProfit)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Stakeado</p>
                    <p className="text-sm font-bold tabular-nums mt-0.5">{fmt(br.totalStaked)}</p>
                  </div>
                </div>

                {/* Ops */}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{br.totalBets} ops · {br.activeBets} en juego</span>
                  {br._count.bookmakers > 0 && (
                    <span>{br._count.bookmakers} {br._count.bookmakers === 1 ? 'casa' : 'casas'}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Create modal */}
      {createOpen && (
        <BankrollFormModal
          title="Nuevo Bankroll"
          onClose={() => { setCreateOpen(false); refresh() }}
        />
      )}

      {/* Edit modal */}
      {editTarget && (
        <BankrollFormModal
          title="Editar Bankroll"
          initial={editTarget}
          onClose={() => { setEditTarget(null); refresh() }}
        />
      )}
    </div>
  )
}

// ─── Delete button (with confirm) ─────────────────────────────────────────────

function DeleteButton({
  bankrollId, name, onDeleted,
}: { bankrollId: string; name: string; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function handleDelete() {
    setBusy(true)
    const res = await deleteBankrollAction(bankrollId)
    setBusy(false)
    if (res.success) {
      toast.success(`Bankroll "${name}" eliminado`)
      onDeleted()
    } else {
      toast.error(res.error ?? 'No se pudo eliminar el bankroll')
      setConfirming(false)
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <button
          onClick={handleDelete}
          disabled={busy}
          className="text-xs text-red-600 hover:underline disabled:opacity-50"
        >
          {busy ? '...' : '¿Eliminar?'}
        </button>
        <button onClick={() => setConfirming(false)} className="text-xs text-muted-foreground hover:underline">
          No
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      title={`Eliminar "${name}"`}
      className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors text-xs"
    >
      🗑️
    </button>
  )
}

// ─── Create / Edit form modal ─────────────────────────────────────────────────

function BankrollFormModal({
  title,
  initial,
  onClose,
}: {
  title:    string
  initial?: BankrollData
  onClose:  () => void
}) {
  const [name,  setName]  = useState(initial?.name ?? '')
  const [color, setColor] = useState(initial?.color ?? '#6366f1')
  const [desc,  setDesc]  = useState(initial?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy,  setBusy]  = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)

    const fd = new FormData()
    fd.append('name',        name.trim())
    fd.append('color',       color)
    fd.append('description', desc.trim())

    const res = initial
      ? await updateBankrollAction(initial.id, fd)
      : await createBankrollAction(fd)

    setBusy(false)
    if (res.success) {
      toast.success(initial ? `Bankroll "${name.trim()}" actualizado` : `Bankroll "${name.trim()}" creado`)
      onClose()
    } else {
      setError(res.error ?? 'Error al guardar')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-card border rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted text-xl transition-colors">×</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Nombre del bankroll</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ej. Surebets Pro"
              required
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Descripción <span className="font-normal">(opcional)</span></label>
            <input
              type="text"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="ej. Operaciones de arbitraje puro"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Color identificativo</label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-10 h-10 rounded-lg border cursor-pointer p-0.5 bg-background"
              />
              <span className="text-sm font-mono text-muted-foreground">{color}</span>
              <span className="w-6 h-6 rounded-full ring-1 ring-black/10" style={{ backgroundColor: color }} />
            </div>
          </div>

          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm text-muted-foreground hover:bg-muted transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors">
              {busy ? 'Guardando...' : initial ? 'Actualizar' : 'Crear'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
