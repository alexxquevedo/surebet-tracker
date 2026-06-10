'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  editBookmakerAction,
  toggleBookmakerStatusAction,
  adjustBookmakerBalanceAction,
  assignBankrollAction,
  setInitialCapitalAction,
} from '@/lib/actions/bookmaker'

// ─── Types ───────────────────────────────────────────────────────────────────

interface BankrollOption {
  id:    string
  name:  string
  color: string
}

interface BookmakerForManage {
  id:             string
  name:           string
  notes:          string | null
  status:         string
  bankrollId:     string | null
  currentBalance: number
  initialCapital: number | null
}

interface Props {
  bookmaker: BookmakerForManage
  bankrolls: BankrollOption[]
}

// ════════════════════════════════════════════════════════════════════════════
// ManageBookmaker
// ════════════════════════════════════════════════════════════════════════════

export function ManageBookmaker({ bookmaker, bankrolls }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [editOpen,    setEditOpen]    = useState(false)
  const [adjustOpen,  setAdjustOpen]  = useState(false)
  const [capitalOpen, setCapitalOpen] = useState(false)
  const [isPending,   setIsPending]   = useState(false)

  const missingCapital = bookmaker.initialCapital === null

  const isSuspended = bookmaker.status === 'SUSPENDED'

  function refresh() {
    startTransition(() => router.refresh())
  }

  async function handleToggle() {
    setIsPending(true)
    const fd = new FormData()
    fd.append('id', bookmaker.id)
    await toggleBookmakerStatusAction(fd)
    setIsPending(false)
    refresh()
  }

  return (
    <div className="flex items-center gap-1 justify-end">
      {/* Bankroll assign */}
      {bankrolls.length > 0 && (
        <select
          defaultValue={bookmaker.bankrollId ?? ''}
          onChange={async (e) => {
            await assignBankrollAction(bookmaker.id, e.target.value || null)
            refresh()
          }}
          className="rounded-md border bg-background text-xs px-2 py-1 outline-none focus:ring-2 focus:ring-ring max-w-[120px]"
          title="Asignar bankroll"
        >
          <option value="">Sin bankroll</option>
          {bankrolls.map((br) => (
            <option key={br.id} value={br.id}>{br.name}</option>
          ))}
        </select>
      )}

      {/* Edit button */}
      <button
        onClick={() => setEditOpen(true)}
        title="Editar nombre"
        className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors text-sm"
      >
        ✏️
      </button>

      {/* Suspend / Activate button */}
      <button
        onClick={handleToggle}
        disabled={isPending}
        title={isSuspended ? 'Activar casa' : 'Suspender casa'}
        className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors text-sm ${
          isSuspended
            ? 'text-green-600 hover:bg-green-50'
            : 'text-amber-600 hover:bg-amber-50'
        }`}
      >
        {isSuspended ? '▶️' : '⏸️'}
      </button>

      {/* Balance adjust button */}
      <button
        onClick={() => setAdjustOpen(true)}
        title="Ajuste manual de saldo"
        className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors text-sm"
      >
        💰
      </button>

      {/* Capital inicial button */}
      <button
        onClick={() => setCapitalOpen(true)}
        title={missingCapital ? 'Registrar capital inicial (requerido para el bot)' : `Capital inicial: ${bookmaker.initialCapital?.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })} — actualizar`}
        className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors text-sm relative ${
          missingCapital
            ? 'text-amber-600 hover:bg-amber-50 ring-1 ring-amber-400'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
      >
        🏦
        {missingCapital && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-500" />
        )}
      </button>

      {/* Modals */}
      {editOpen    && <EditModal    bookmaker={bookmaker} onClose={() => { setEditOpen(false);    refresh() }} />}
      {adjustOpen  && <AdjustModal  bookmaker={bookmaker} onClose={() => { setAdjustOpen(false);  refresh() }} />}
      {capitalOpen && <CapitalModal bookmaker={bookmaker} onClose={() => { setCapitalOpen(false); refresh() }} />}
    </div>
  )
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────

function EditModal({ bookmaker, onClose }: { bookmaker: BookmakerForManage; onClose: () => void }) {
  const [name,  setName]  = useState(bookmaker.name)
  const [notes, setNotes] = useState(bookmaker.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy,  setBusy]  = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    const fd = new FormData()
    fd.append('id',    bookmaker.id)
    fd.append('name',  name.trim())
    fd.append('notes', notes.trim())
    const res = await editBookmakerAction(fd)
    setBusy(false)
    if (res.success) onClose()
    else setError(res.error)
  }

  return (
    <Modal title="Editar casa" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Nombre</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Notas <span className="font-normal">(opcional)</span></label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
          />
        </div>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm text-muted-foreground hover:bg-muted transition-colors">
            Cancelar
          </button>
          <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors">
            {busy ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ─── Adjust Balance Modal ─────────────────────────────────────────────────────

function AdjustModal({ bookmaker, onClose }: { bookmaker: BookmakerForManage; onClose: () => void }) {
  const [amount,    setAmount]    = useState('')
  const [direction, setDirection] = useState<'deposit' | 'withdrawal'>('deposit')
  const [notes,     setNotes]     = useState('')
  const [error,     setError]     = useState<string | null>(null)
  const [busy,      setBusy]      = useState(false)

  const amountNum  = parseFloat(amount)
  const isValid    = !isNaN(amountNum) && amountNum > 0

  const newBalance = isValid
    ? bookmaker.currentBalance + (direction === 'deposit' ? amountNum : -amountNum)
    : null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!isValid) return
    setBusy(true)
    const fd = new FormData()
    fd.append('id',        bookmaker.id)
    fd.append('amount',    String(amountNum))
    fd.append('direction', direction)
    fd.append('notes',     notes.trim() || 'Ajuste manual')
    const res = await adjustBookmakerBalanceAction(fd)
    setBusy(false)
    if (res.success) onClose()
    else setError(res.error)
  }

  const fmt = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })

  return (
    <Modal title="Ajuste manual de saldo" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

        <div className="rounded-lg bg-muted/40 border px-3 py-2.5 text-xs">
          <span className="text-muted-foreground">Saldo actual: </span>
          <span className="font-semibold tabular-nums">{fmt(bookmaker.currentBalance)}</span>
        </div>

        {/* Direction toggle */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Tipo de ajuste</label>
          <div className="grid grid-cols-2 gap-2">
            {(['deposit', 'withdrawal'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDirection(d)}
                className={`py-2 text-sm rounded-lg border font-medium transition-colors ${
                  direction === d
                    ? d === 'deposit'
                      ? 'bg-green-600 text-white border-green-600'
                      : 'bg-red-600 text-white border-red-600'
                    : 'bg-background border-input text-muted-foreground hover:bg-muted'
                }`}
              >
                {d === 'deposit' ? '↑ Depósito' : '↓ Retirada'}
              </button>
            ))}
          </div>
        </div>

        {/* Amount */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Importe (€)</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            required
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Notes */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Motivo <span className="font-normal">(opcional)</span></label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="ej. Retiro del 05/06"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Preview */}
        {newBalance !== null && (
          <div className="rounded-lg bg-muted/40 border px-3 py-2.5 text-xs flex justify-between">
            <span className="text-muted-foreground">Nuevo saldo:</span>
            <span className={`font-bold tabular-nums ${newBalance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {fmt(newBalance)}
            </span>
          </div>
        )}

        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          ⚠️ Este ajuste queda registrado en el log de auditoría como MANUAL_ADJUSTMENT.
        </div>

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm text-muted-foreground hover:bg-muted transition-colors">
            Cancelar
          </button>
          <button type="submit" disabled={busy || !isValid} className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors">
            {busy ? 'Aplicando...' : 'Aplicar ajuste'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ─── Capital Inicial Modal ────────────────────────────────────────────────────

function CapitalModal({ bookmaker, onClose }: { bookmaker: BookmakerForManage; onClose: () => void }) {
  const isUpdate = bookmaker.initialCapital !== null
  const [amount, setAmount] = useState(
    bookmaker.initialCapital !== null ? String(bookmaker.initialCapital) : '',
  )
  const [error, setError] = useState<string | null>(null)
  const [busy,  setBusy]  = useState(false)

  const amountNum = parseFloat(amount)
  const isValid   = !isNaN(amountNum) && amountNum >= 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!isValid) return
    setBusy(true)
    const res = await setInitialCapitalAction(bookmaker.id, amountNum)
    setBusy(false)
    if (res.success) onClose()
    else setError(res.error)
  }

  const fmt = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })

  return (
    <Modal title={isUpdate ? 'Actualizar capital inicial' : 'Registrar capital inicial'} onClose={onClose}>
      <div className="text-xs text-muted-foreground bg-muted/40 border rounded-lg px-3 py-2.5 leading-relaxed">
        El capital inicial es el saldo que tenías en <span className="font-semibold">{bookmaker.name}</span> antes de empezar a registrar apuestas aquí. Sin él, las apuestas del bot se guardan como <span className="font-semibold text-amber-700">borradores</span>.
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Capital inicial (€)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            required
            autoFocus
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {isValid && (
            <p className="text-xs text-muted-foreground">= {fmt(amountNum)}</p>
          )}
        </div>

        {!isUpdate && (
          <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-800">
            Una vez registrado, las nuevas apuestas del bot se procesarán directamente — no irán a borradores.
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm text-muted-foreground hover:bg-muted transition-colors">
            Cancelar
          </button>
          <button type="submit" disabled={busy || !isValid} className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors">
            {busy ? 'Guardando...' : isUpdate ? 'Actualizar' : 'Registrar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ─── Shared Modal wrapper ─────────────────────────────────────────────────────

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
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
        {children}
      </div>
    </div>
  )
}
