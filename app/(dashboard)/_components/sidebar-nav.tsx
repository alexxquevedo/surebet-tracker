'use client'

import { useState, useEffect, useTransition, useMemo, useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import Decimal from 'decimal.js'
import { createQuickBetAction, createMultiLegBetAction, createComboBetAction } from '@/lib/actions/bet-record'

// ─── Types ───────────────────────────────────────────────────────────────────

interface BookmakerOption {
  id:    string
  name:  string
  color: string | null
}

interface BankrollOption {
  id:    string
  name:  string
  color: string
}

interface Props {
  bookmakers:        BookmakerOption[]
  bankrolls:         BankrollOption[]
  plan:              string
  userName:          string | null | undefined
  userEmail:         string | null | undefined
  isAdmin:           boolean
  usedCompetitions:  string[]
}

// ─── Nav links ───────────────────────────────────────────────────────────────

const NAV_LINKS = [
  { href: '/dashboard',   label: 'Dashboard',          icon: '📊',  proOnly: false },
  { href: '/bookmakers',  label: 'Casas de apuestas',  icon: '🏦',  proOnly: false },
  { href: '/records',     label: 'Operaciones',        icon: '📋',  proOnly: false },
  { href: '/stats',       label: 'Estadísticas',       icon: '📈',  proOnly: true  },
  { href: '/settings',    label: 'Configuración',      icon: '⚙️',  proOnly: false },
] as const

// ─── Bet type config ─────────────────────────────────────────────────────────

const BET_TYPES = [
  { value: 'SINGLE',    label: '⚽ Single',      multi: false, combo: false },
  { value: 'CASINO',    label: '🎰 Casino',      multi: false, combo: false },
  { value: 'COMBO',     label: '📋 Combinada',   multi: false, combo: true  },
  { value: 'ARBITRAGE', label: '⚡ Surebets',    multi: true,  combo: false },
  { value: 'MIDDLE',    label: '🎯 Middlebet',   multi: true,  combo: false },
] as const

type ModalBetType = (typeof BET_TYPES)[number]['value']

const SPORTS = [
  { value: 'FOOTBALL',   label: '⚽ Fútbol' },
  { value: 'BASKETBALL', label: '🏀 Baloncesto' },
  { value: 'TENNIS',     label: '🎾 Tenis' },
  { value: 'HOCKEY',     label: '🏒 Hockey' },
  { value: 'BASEBALL',   label: '⚾ Béisbol' },
  { value: 'RUGBY',      label: '🏉 Rugby' },
  { value: 'MMA',        label: '🥋 MMA' },
  { value: 'BOXING',     label: '🥊 Boxeo' },
  { value: 'MOTORSPORT', label: '🏎️ Motorsport' },
  { value: 'ESPORTS',    label: '🎮 eSports' },
  { value: 'OTHER',      label: '🎯 Otro' },
] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateStake(raw: string): string | null {
  if (!raw) return null
  const n = parseFloat(raw)
  if (isNaN(n)) return 'Stake: valor inválido'
  if (n <= 0)   return 'Stake: debe ser mayor que 0'
  return null
}

function validateOdds(raw: string, label = 'Cuota'): string | null {
  if (!raw) return null
  const n = parseFloat(raw)
  if (isNaN(n)) return `${label}: valor inválido`
  if (n <= 1)   return `${label}: debe ser mayor que 1`
  return null
}

function defaultDateTime() {
  const now = new Date()
  // Return local time without offset suffix (for datetime-local input)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

// Convert datetime-local string ("2026-06-10T14:30") to UTC ISO string
// The browser input is always in local time — convert before sending to server
function localToUTC(datetimeLocal: string): string {
  const d = new Date(datetimeLocal) // browser: treats as LOCAL time
  return isNaN(d.getTime()) ? datetimeLocal : d.toISOString()
}

// ════════════════════════════════════════════════════════════════════════════
// SIDEBAR NAV (Client Component)
// ════════════════════════════════════════════════════════════════════════════

export function SidebarNav({ bookmakers, bankrolls, plan, userName, userEmail, isAdmin, usedCompetitions }: Props) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [cloneData, setCloneData] = useState<CloneData | null>(null)

  useEffect(() => {
    function handleClone() {
      const raw = localStorage.getItem('clone_bet')
      if (!raw) return
      localStorage.removeItem('clone_bet')
      try {
        setCloneData(JSON.parse(raw) as CloneData)
        setOpen(true)
      } catch {}
    }
    window.addEventListener('dualstats:clone_bet', handleClone)
    return () => window.removeEventListener('dualstats:clone_bet', handleClone)
  }, [])

  return (
    <>
      <aside className="w-60 border-r bg-card hidden md:flex flex-col shrink-0 sticky top-0 h-screen overflow-y-auto">

        {/* Logo + plan */}
        <div className="p-5 border-b">
          <span className="font-bold text-base tracking-tight">DualStats Tracker</span>
          <span className="ml-2 text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide">
            {plan}
          </span>
        </div>

        {/* + Nueva Operación */}
        <div className="p-3 border-b">
          <button
            onClick={() => setOpen(true)}
            className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground text-sm font-semibold px-3 py-2 rounded-lg hover:bg-primary/90 transition-colors shadow-sm"
          >
            <span className="text-lg leading-none">+</span>
            Nueva Operación
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-0.5">
          {NAV_LINKS.map((link) => {
            const isActive =
              pathname === link.href ||
              (link.href !== '/dashboard' && pathname.startsWith(link.href + '/'))
            const locked = link.proOnly && plan === 'FREE'
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors ${
                  isActive
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                <span className="text-base leading-none">{link.icon}</span>
                <span className="flex-1">{link.label}</span>
                {locked && (
                  <span className="text-[10px] font-bold bg-primary/10 text-primary px-1.5 py-0.5 rounded uppercase tracking-wide">
                    PRO
                  </span>
                )}
              </Link>
            )
          })}

          {/* Admin — solo visible para admins */}
          {isAdmin && (
            <Link
              href="/admin/users"
              className={`flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors ${
                pathname.startsWith('/admin')
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <span className="text-base leading-none">🛡️</span>
              <span className="flex-1">Admin</span>
              <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded uppercase tracking-wide">
                ADM
              </span>
            </Link>
          )}
        </nav>

        {/* User + sign-out + theme */}
        <div className="p-3 border-t space-y-1">
          <div className="px-3 py-1 flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate">{userName ?? userEmail ?? 'Usuario'}</p>
              {userName && userEmail && (
                <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
              )}
            </div>
            <ThemeToggle />
          </div>
          <button
            onClick={() => void signOut({ callbackUrl: '/login' })}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <span className="text-base leading-none">🚪</span>
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* ─── Mobile Bottom Navigation Bar (md:hidden) ────────────────── */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-16 bg-card border-t flex items-stretch"
        aria-label="Navegación principal"
      >
        {(
          [
            { href: '/dashboard',  label: 'Inicio',   icon: '📊' },
            { href: '/bookmakers', label: 'Casas',    icon: '🏦' },
            { href: '/records',    label: 'Ops.',     icon: '📋' },
            { href: '/stats',      label: 'Stats',    icon: '📈' },
            { href: '/settings',   label: 'Ajustes',  icon: '⚙️' },
          ] as const
        ).map((link) => {
          const isActive =
            pathname === link.href ||
            (link.href !== '/dashboard' && pathname.startsWith(link.href + '/'))
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors relative ${
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="text-xl leading-none">{link.icon}</span>
              <span className="text-[10px] font-medium leading-tight">{link.label}</span>
              {link.href === '/stats' && plan === 'FREE' && (
                <span className="absolute top-1 right-1 text-[8px] font-bold bg-primary text-primary-foreground px-1 rounded leading-tight">
                  PRO
                </span>
              )}
            </Link>
          )
        })}
        {isAdmin && (
          <Link
            href="/admin/users"
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors relative ${
              pathname.startsWith('/admin')
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <span className="text-xl leading-none">🛡️</span>
            <span className="text-[10px] font-medium leading-tight">Admin</span>
          </Link>
        )}
      </nav>

      {/* ─── FAB Nueva Operación (móvil, md:hidden) ───────────────────── */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Nueva Operación"
        className="md:hidden fixed bottom-20 right-4 z-40 h-14 w-14 rounded-full bg-primary text-primary-foreground text-3xl font-light shadow-xl flex items-center justify-center hover:bg-primary/90 active:scale-95 transition-all"
      >
        +
      </button>

      {open && (
        <NewOperationModal
          bookmakers={bookmakers}
          bankrolls={bankrolls}
          usedCompetitions={usedCompetitions}
          initialValues={cloneData ?? undefined}
          onClose={() => { setOpen(false); setCloneData(null) }}
        />
      )}
    </>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// MODAL DE NUEVA OPERACIÓN
// ════════════════════════════════════════════════════════════════════════════

interface ComboRow {
  description: string
  eventName:   string
  sport:       string
  competition: string
}

interface CloneData {
  betType:      ModalBetType
  selection?:   string
  eventName?:   string
  sport?:       string
  competition?: string
  bm1Id?:       string
  bm2Id?:       string
  comboRows?:   ComboRow[]
}

function NewOperationModal({
  bookmakers,
  bankrolls,
  usedCompetitions,
  initialValues,
  onClose,
}: {
  bookmakers:        BookmakerOption[]
  bankrolls:         BankrollOption[]
  usedCompetitions:  string[]
  initialValues?:    CloneData
  onClose:           () => void
}) {
  const iv = initialValues
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [betType, setBetType] = useState<ModalBetType>(iv?.betType ?? 'SINGLE')
  const isMulti  = BET_TYPES.find((t) => t.value === betType)?.multi  ?? false
  const isCombo  = BET_TYPES.find((t) => t.value === betType)?.combo  ?? false

  // ── Shared metadata ─────────────────────────────────────────────────────
  const [selection, setSelection]     = useState(iv?.selection   ?? '')
  const [eventName, setEventName]     = useState(iv?.eventName   ?? '')
  const [sport, setSport]             = useState(iv?.sport       ?? '')
  const [competition, setCompetition] = useState(iv?.competition ?? '')
  const [isLive, setIsLive]           = useState(false)
  const [datePlaced, setDatePlaced]   = useState(defaultDateTime)
  const [middleRange, setMiddleRange] = useState('')
  const [bankrollId, setBankrollId]   = useState('')

  // ── Leg 1 (single + multi) ───────────────────────────────────────────────
  const [bm1Id, setBm1Id]     = useState(iv?.bm1Id ?? bookmakers[0]?.id ?? '')
  const [stake1, setStake1]   = useState('')
  const [odds1, setOdds1]     = useState('')
  const [retorno1, setRetorno1] = useState('') // retorno bruto = stake × odds

  // ── Leg 2 (multi only) ──────────────────────────────────────────────────
  const [bm2Id, setBm2Id]     = useState(iv?.bm2Id ?? bookmakers[1]?.id ?? bookmakers[0]?.id ?? '')
  const [stake2, setStake2]   = useState('')
  const [odds2, setOdds2]     = useState('')

  // ── Combinada fields ────────────────────────────────────────────────────
  const [comboRows, setComboRows]         = useState<ComboRow[]>(
    iv?.comboRows ?? [{ description: '', eventName: '', sport: '', competition: '' }]
  )
  const [comboOdds, setComboOdds]         = useState('')
  const [comboRetorno, setComboRetorno]   = useState('') // opcional: retorno total incluyendo bonus

  const [isPending, setIsPending] = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [success, setSuccess]     = useState(false)

  // ── Sync retorno ↔ cuota (single-leg) ──────────────────────────────────
  function handleOdds1Change(v: string) {
    setOdds1(v)
    const s = parseFloat(stake1), o = parseFloat(v)
    if (!isNaN(s) && !isNaN(o) && s > 0 && o > 0) {
      setRetorno1(new Decimal(s).mul(o).toDecimalPlaces(2).toString())
    }
  }

  function handleStake1Change(v: string) {
    setStake1(v)
    const s = parseFloat(v), o = parseFloat(odds1)
    if (!isNaN(s) && !isNaN(o) && s > 0 && o > 0) {
      setRetorno1(new Decimal(s).mul(o).toDecimalPlaces(2).toString())
    }
  }

  function handleRetorno1Change(v: string) {
    setRetorno1(v)
    const r = parseFloat(v), s = parseFloat(stake1)
    if (!isNaN(r) && !isNaN(s) && s > 0 && r > 0) {
      setOdds1(new Decimal(r).div(s).toDecimalPlaces(4).toString())
    }
  }

  // ── Sync retorno ↔ cuota (combo) ─────────────────────────────────────
  function handleComboOddsChange(v: string) {
    setComboOdds(v)
    const s = parseFloat(stake1), o = parseFloat(v)
    if (!isNaN(s) && !isNaN(o) && s > 0 && o > 0) {
      setComboRetorno(new Decimal(s).mul(o).toDecimalPlaces(2).toString())
    }
  }

  function handleComboStakeChange(v: string) {
    setStake1(v)
    const s = parseFloat(v), o = parseFloat(comboOdds)
    if (!isNaN(s) && !isNaN(o) && s > 0 && o > 0) {
      setComboRetorno(new Decimal(s).mul(o).toDecimalPlaces(2).toString())
    }
  }

  function handleComboRetornoChange(v: string) {
    setComboRetorno(v)
    // Don't update odds when user manually enters retorno (it's a bonus)
  }

  // ── Combo rows ──────────────────────────────────────────────────────────
  const addComboRow = useCallback(() => {
    setComboRows((prev) => [...prev, { description: '', eventName: '', sport: '', competition: '' }])
  }, [])

  const removeComboRow = useCallback((idx: number) => {
    setComboRows((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const updateComboRow = useCallback((idx: number, field: keyof ComboRow, val: string) => {
    setComboRows((prev) => prev.map((r, i) => i === idx ? { ...r, [field]: val } : r))
  }, [])

  // ── Validation ─────────────────────────────────────────────────────────
  const s1err   = validateStake(stake1)
  const o1err   = !isCombo ? validateOdds(odds1) : null
  const s2err   = isMulti  ? validateStake(stake2)          : null
  const o2err   = isMulti  ? validateOdds(odds2, 'Cuota 2') : null
  const coErr   = isCombo  ? validateOdds(comboOdds, 'Cuota total') : null
  const hasErr  = !!(s1err || o1err || s2err || o2err || coErr)

  // ── Profit preview ──────────────────────────────────────────────────────
  const profitPreview = useMemo(() => {
    const s1n = parseFloat(stake1)
    if (!stake1 || isNaN(s1n) || s1n <= 0) return null

    if (isCombo) {
      const oN = parseFloat(comboOdds)
      const rN = parseFloat(comboRetorno)
      if (!comboOdds || isNaN(oN)) return null
      const calcReturn = new Decimal(s1n).mul(oN).toDecimalPlaces(2)
      const displayReturn = (!isNaN(rN) && rN > 0) ? new Decimal(rN) : calcReturn
      const profit = displayReturn.minus(s1n).toDecimalPlaces(2).toNumber()
      return { label: 'Retorno total estimado', value: displayReturn.toNumber(), profit }
    }

    const o1n = parseFloat(odds1)
    const r1n = parseFloat(retorno1)
    if (!odds1 || isNaN(o1n)) return null

    if (!isMulti) {
      const displayReturn = (!isNaN(r1n) && r1n > 0) ? r1n : new Decimal(s1n).mul(o1n).toDecimalPlaces(2).toNumber()
      const profit = new Decimal(displayReturn).minus(s1n).toDecimalPlaces(2).toNumber()
      return { label: 'Retorno bruto si gana', value: displayReturn, profit }
    }

    const s2n = parseFloat(stake2), o2n = parseFloat(odds2)
    if (!stake2 || !odds2 || isNaN(s2n) || isNaN(o2n)) return null
    const ret1       = new Decimal(s1n).mul(o1n).toDecimalPlaces(2)
    const ret2       = new Decimal(s2n).mul(o2n).toDecimalPlaces(2)
    const totalStake = new Decimal(s1n).plus(s2n).toDecimalPlaces(2)

    if (betType === 'ARBITRAGE') {
      const guaranteed = Decimal.min(ret1, ret2).minus(totalStake).toDecimalPlaces(2).toNumber()
      const pct        = totalStake.isZero() ? 0 : new Decimal(guaranteed).div(totalStake).mul(100).toDecimalPlaces(2).toNumber()
      return { label: 'Beneficio garantizado', value: guaranteed, pct }
    } else {
      const best  = ret1.plus(ret2).minus(totalStake).toDecimalPlaces(2).toNumber()
      const worst = Decimal.max(ret1, ret2).minus(totalStake).toDecimalPlaces(2).toNumber()
      return { label: 'Si middle entra', value: best, worstLabel: 'Si no entra', worst }
    }
  }, [stake1, odds1, retorno1, stake2, odds2, comboOdds, comboRetorno, betType, isMulti, isCombo])

  // ── Reset ───────────────────────────────────────────────────────────────
  function resetForm() {
    setSelection(''); setEventName(''); setSport(''); setCompetition(''); setIsLive(false); setDatePlaced(defaultDateTime())
    setMiddleRange(''); setStake1(''); setOdds1(''); setRetorno1('')
    setStake2(''); setOdds2(''); setBankrollId('')
    setBm1Id(bookmakers[0]?.id ?? ''); setBm2Id(bookmakers[1]?.id ?? bookmakers[0]?.id ?? '')
    setComboRows([{ description: '', eventName: '', sport: '', competition: '' }])
    setComboOdds(''); setComboRetorno('')
    setError(null)
  }

  function handleTypeChange(t: ModalBetType) {
    setBetType(t)
    resetForm()
  }

  // ── Submit ──────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (hasErr || bookmakers.length === 0) return
    setError(null)
    setIsPending(true)

    const fd = new FormData()
    fd.append('type',        betType)
    fd.append('selection',   selection)
    fd.append('eventName',   eventName)
    fd.append('sport',       sport)
    fd.append('competition', competition)
    fd.append('isLive',      String(isLive))
    fd.append('datePlaced',  localToUTC(datePlaced))
    if (bankrollId) fd.append('bankrollId', bankrollId)

    let result: { success: boolean; error?: string; id?: string }

    if (isCombo) {
      fd.append('bookmakerId',   bm1Id)
      fd.append('stake',         stake1)
      fd.append('totalOdds',     comboOdds)
      if (comboRetorno) fd.append('bonusReturn', comboRetorno)
      fd.append('selections',    JSON.stringify(comboRows))
      result = await createComboBetAction(fd)
    } else if (isMulti) {
      fd.append('bm1Id',       bm1Id)
      fd.append('odds1',       odds1)
      fd.append('stake1',      stake1)
      fd.append('bm2Id',       bm2Id)
      fd.append('odds2',       odds2)
      fd.append('stake2',      stake2)
      if (betType === 'MIDDLE') fd.append('middleRange', middleRange)
      result = await createMultiLegBetAction(fd)
    } else {
      fd.append('bookmakerId', bm1Id)
      fd.append('stake',       stake1)
      fd.append('odds',        odds1)
      result = await createQuickBetAction(fd)
    }

    setIsPending(false)

    if (result.success) {
      setSuccess(true)
      startTransition(() => router.refresh())
      setTimeout(onClose, 1500)
    } else {
      setError(result.error ?? 'Error desconocido')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-card border rounded-xl shadow-xl w-full max-w-md p-6 space-y-5 max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{iv ? 'Clonar Operación' : 'Nueva Operación'}</h2>
          <button onClick={onClose} aria-label="Cerrar"
            className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted text-xl transition-colors">
            ×
          </button>
        </div>

        {success ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <span className="text-5xl">✅</span>
            <p className="font-semibold text-lg">¡Operación registrada!</p>
            <p className="text-sm text-muted-foreground">Actualizando dashboard...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">

            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
            )}

            {/* Tipo */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold">Tipo de operación</label>
              <div className="grid grid-cols-3 gap-2">
                {BET_TYPES.map((t) => (
                  <button key={t.value} type="button" onClick={() => handleTypeChange(t.value)}
                    className={`text-xs py-2 px-2 rounded-lg border font-medium transition-colors text-left leading-tight ${
                      betType === t.value
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
                    }`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Bankroll (si hay alguno) */}
            {bankrolls.length > 0 && (
              <div className="space-y-1.5">
                <label className="block text-sm font-semibold">
                  Bankroll <span className="font-normal text-muted-foreground">(opcional)</span>
                </label>
                <select
                  value={bankrollId}
                  onChange={(e) => setBankrollId(e.target.value)}
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">— Sin asignar —</option>
                  {bankrolls.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Live / Pre-partido toggle */}
            <div className="space-y-1.5">
              <label className="block text-sm font-semibold">Momento</label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: false, label: '📅 Pre-partido' },
                  { value: true,  label: '⚡ Live' },
                ] as const).map(({ value, label }) => (
                  <button
                    key={String(value)}
                    type="button"
                    onClick={() => setIsLive(value)}
                    className={`py-1.5 text-xs rounded-lg border font-medium transition-colors ${
                      isLive === value
                        ? value
                          ? 'bg-red-600 text-white border-red-600'
                          : 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Fecha y hora */}
            <div className="space-y-1.5">
              <label className="block text-sm font-semibold">Fecha y hora de la apuesta</label>
              <input
                type="datetime-local"
                value={datePlaced}
                onChange={(e) => setDatePlaced(e.target.value)}
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* ═══ COMBINADA ══════════════════════════════════════════════ */}
            {isCombo ? (
              <>
                {/* Casa de apuestas */}
                <div className="space-y-1.5">
                  <label className="block text-sm font-semibold">Casa de apuestas</label>
                  {bookmakers.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">
                      Añade casas desde{' '}
                      <Link href="/bookmakers" className="text-primary underline">Casas de apuestas</Link>.
                    </p>
                  ) : (
                    <select value={bm1Id} onChange={(e) => setBm1Id(e.target.value)} required
                      className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
                      {bookmakers.map((bm) => (
                        <option key={bm.id} value={bm.id}>{bm.name}</option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Stake + Cuota total + Retorno */}
                <div className="grid grid-cols-3 gap-2">
                  <NumberField label="Stake (€)" value={stake1} onChange={handleComboStakeChange}
                    placeholder="100.00" step="0.01" min="0.01" error={s1err} />
                  <NumberField label="Cuota total" value={comboOdds} onChange={handleComboOddsChange}
                    placeholder="5.00" step="any" error={coErr} />
                  <NumberField label="Retorno total" value={comboRetorno} onChange={handleComboRetornoChange}
                    placeholder="520.00" step="any" helpText="Incl. bonus" />
                </div>

                {/* Selecciones */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-semibold">
                      Selecciones <span className="font-normal text-muted-foreground text-xs">({comboRows.length})</span>
                    </label>
                    <button
                      type="button"
                      onClick={addComboRow}
                      className="text-xs text-primary hover:underline font-medium"
                    >
                      + Añadir selección
                    </button>
                  </div>

                  <div className="space-y-2">
                    {comboRows.map((row, idx) => (
                      <div key={idx} className="rounded-lg border bg-muted/20 p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            Sel. {idx + 1}
                          </span>
                          {comboRows.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeComboRow(idx)}
                              className="text-xs text-red-500 hover:text-red-700 transition-colors"
                              aria-label="Eliminar selección"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        <input
                          type="text"
                          value={row.description}
                          onChange={(e) => updateComboRow(idx, 'description', e.target.value)}
                          placeholder="Selección (ej. Real Madrid a ganar)"
                          className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                        />
                        <input
                          type="text"
                          value={row.eventName}
                          onChange={(e) => updateComboRow(idx, 'eventName', e.target.value)}
                          placeholder="Partido (ej. Real Madrid vs Barça)"
                          className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <select
                            value={row.sport}
                            onChange={(e) => updateComboRow(idx, 'sport', e.target.value)}
                            className="rounded-lg border bg-background px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                          >
                            <option value="">Deporte</option>
                            {SPORTS.map((s) => (
                              <option key={s.value} value={s.value}>{s.label}</option>
                            ))}
                          </select>
                          <CompetitionInput
                            value={row.competition}
                            onChange={(v) => updateComboRow(idx, 'competition', v)}
                            placeholder="Competición"
                            usedCompetitions={usedCompetitions}
                            className="rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-full"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              /* ═══ SINGLE / CASINO / MULTI ══════════════════════════════ */
              <>
                {/* Evento / Selección — para casino se convierte en "¿Qué has jugado?" */}
                <div className="space-y-1.5">
                  <label className="block text-sm font-semibold">
                    {betType === 'CASINO' ? '¿Qué has jugado?' : 'Evento / Selección'}
                    {betType !== 'CASINO' && (
                      <span className="font-normal text-muted-foreground"> (opcional)</span>
                    )}
                  </label>
                  <input type="text" value={selection} onChange={(e) => setSelection(e.target.value)}
                    placeholder={betType === 'CASINO'
                      ? 'ej. Ruleta, Slots, Blackjack, Póker...'
                      : 'ej. Superaumento Canada ganará'}
                    className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
                </div>

                {/* Partido (solo SINGLE) */}
                {betType === 'SINGLE' && (
                  <div className="space-y-1.5">
                    <label className="block text-sm font-semibold">
                      Partido <span className="font-normal text-muted-foreground">(opcional)</span>
                    </label>
                    <input type="text" value={eventName} onChange={(e) => setEventName(e.target.value)}
                      placeholder="ej. CAN - BIH"
                      className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
                  </div>
                )}

                {/* Deporte (oculto en casino y multi) */}
                {betType !== 'CASINO' && !isMulti && (
                  <div className="space-y-1.5">
                    <label className="block text-sm font-semibold">
                      Deporte <span className="font-normal text-muted-foreground">(opcional)</span>
                    </label>
                    <select
                      value={sport}
                      onChange={(e) => setSport(e.target.value)}
                      className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="">Sin especificar</option>
                      {SPORTS.map((s) => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Competición (solo SINGLE) */}
                {betType === 'SINGLE' && (
                  <div className="space-y-1.5">
                    <label className="block text-sm font-semibold">
                      Competición <span className="font-normal text-muted-foreground">(opcional)</span>
                    </label>
                    <CompetitionInput
                      value={competition}
                      onChange={setCompetition}
                      placeholder="ej. La Liga, Champions, Mundial 2026..."
                      usedCompetitions={usedCompetitions}
                      className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                )}

                {isMulti ? (
                  <>
                    {betType === 'MIDDLE' && (
                      <div className="space-y-1.5">
                        <label className="block text-sm font-semibold">Franja del middle</label>
                        <input type="text" value={middleRange} onChange={(e) => setMiddleRange(e.target.value)}
                          placeholder="ej. Resultado entre 3–4 goles"
                          className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
                      </div>
                    )}

                    <LegFields
                      label="🔵 Leg 1"
                      bookmakers={bookmakers}
                      bmId={bm1Id} onBmChange={setBm1Id}
                      stake={stake1} onStakeChange={setStake1}
                      odds={odds1}  onOddsChange={setOdds1}
                      stakeErr={s1err} oddsErr={o1err}
                    />
                    <LegFields
                      label="🔴 Leg 2"
                      bookmakers={bookmakers}
                      bmId={bm2Id} onBmChange={setBm2Id}
                      stake={stake2} onStakeChange={setStake2}
                      odds={odds2}  onOddsChange={setOdds2}
                      stakeErr={s2err} oddsErr={o2err}
                    />
                  </>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <label className="block text-sm font-semibold">Casa de apuestas</label>
                      {bookmakers.length === 0 ? (
                        <p className="text-sm text-muted-foreground italic">
                          Añade casas desde{' '}
                          <Link href="/bookmakers" className="text-primary underline">Casas de apuestas</Link>.
                        </p>
                      ) : (
                        <select value={bm1Id} onChange={(e) => setBm1Id(e.target.value)} required
                          className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
                          {bookmakers.map((bm) => (
                            <option key={bm.id} value={bm.id}>{bm.name}</option>
                          ))}
                        </select>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <NumberField label="Stake (€)" value={stake1} onChange={handleStake1Change}
                        placeholder="100.00" step="0.01" min="0.01" error={s1err} />
                      <NumberField label="Cuota" value={odds1} onChange={handleOdds1Change}
                        placeholder="2.10" step="any" error={o1err} />
                      <NumberField label="Retorno total" value={retorno1} onChange={handleRetorno1Change}
                        placeholder="210.00" step="any" helpText="Bruto (con stake)" />
                    </div>
                  </>
                )}
              </>
            )}

            {/* Profit preview */}
            {profitPreview !== null && (
              <div className="rounded-lg bg-muted/40 border px-3 py-2.5 text-xs space-y-1">
                {'worst' in profitPreview && profitPreview.worst !== undefined ? (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{profitPreview.label}</span>
                      <span className={`font-bold tabular-nums ${profitPreview.value >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {profitPreview.value >= 0 ? '+' : ''}{profitPreview.value.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{(profitPreview as { worstLabel?: string }).worstLabel}</span>
                      <span className={`font-bold tabular-nums ${profitPreview.worst >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {profitPreview.worst >= 0 ? '+' : ''}{profitPreview.worst.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                      </span>
                    </div>
                  </>
                ) : 'profit' in profitPreview ? (
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{profitPreview.label}</span>
                      <span className="font-bold tabular-nums text-foreground">
                        {(profitPreview as { value: number }).value.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Beneficio neto</span>
                      <span className={`font-bold tabular-nums ${(profitPreview as { profit: number }).profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {(profitPreview as { profit: number }).profit >= 0 ? '+' : ''}{(profitPreview as { profit: number }).profit.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {profitPreview.label}
                      {'pct' in profitPreview && profitPreview.pct !== undefined && (
                        <span className="ml-1.5 text-green-600">({profitPreview.pct.toFixed(2)}%)</span>
                      )}
                    </span>
                    <span className={`font-bold tabular-nums ${profitPreview.value >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {profitPreview.value >= 0 ? '+' : ''}{profitPreview.value.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Status info */}
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 flex items-start gap-2 text-xs text-amber-800">
              <span className="shrink-0 mt-0.5">⏳</span>
              <span>Se registra como <strong>En Juego (PLACED)</strong>. Liquídala desde Operaciones una vez conozcas el resultado.</span>
            </div>

            {/* Submit */}
            <button type="submit" disabled={isPending || hasErr || bookmakers.length === 0}
              className="w-full rounded-lg bg-primary text-primary-foreground px-3 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {isPending ? 'Registrando...' : 'Registrar Operación'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LegFields({
  label, bookmakers,
  bmId, onBmChange,
  stake, onStakeChange,
  odds, onOddsChange,
  stakeErr, oddsErr,
}: {
  label: string
  bookmakers: BookmakerOption[]
  bmId: string; onBmChange: (v: string) => void
  stake: string; onStakeChange: (v: string) => void
  odds: string;  onOddsChange: (v: string) => void
  stakeErr: string | null; oddsErr: string | null
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
      <select value={bmId} onChange={(e) => onBmChange(e.target.value)} required
        className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
        {bookmakers.map((bm) => (
          <option key={bm.id} value={bm.id}>{bm.name}</option>
        ))}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Stake (€)" value={stake} onChange={onStakeChange}
          placeholder="100.00" step="0.01" min="0.01" error={stakeErr} />
        <NumberField label="Cuota" value={odds} onChange={onOddsChange}
          placeholder="2.10" step="any" error={oddsErr} />
      </div>
    </div>
  )
}

function CompetitionInput({
  value, onChange, placeholder, usedCompetitions, className,
}: {
  value: string; onChange: (v: string) => void
  placeholder?: string; usedCompetitions: string[]; className?: string
}) {
  const [show, setShow] = useState(false)
  const matches = useMemo(() => {
    if (!usedCompetitions.length) return []
    const q = value.toLowerCase()
    return usedCompetitions.filter((c) => !q || c.toLowerCase().includes(q)).slice(0, 6)
  }, [value, usedCompetitions])

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setShow(true)}
        onBlur={() => setTimeout(() => setShow(false), 150)}
        placeholder={placeholder}
        className={className}
        autoComplete="off"
      />
      {show && matches.length > 0 && (
        <ul className="absolute z-50 left-0 right-0 bg-card border rounded-lg shadow-lg mt-1 text-sm overflow-hidden max-h-40 overflow-y-auto">
          {matches.map((c) => (
            <li
              key={c}
              onMouseDown={(e) => { e.preventDefault(); onChange(c); setShow(false) }}
              className="px-3 py-1.5 hover:bg-muted cursor-pointer truncate"
            >
              {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function NumberField({
  label, value, onChange, placeholder, step, min, error, helpText,
}: {
  label: string; value: string; onChange: (v: string) => void
  placeholder: string; step: string; min?: string; error?: string | null; helpText?: string
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-muted-foreground">
        {label}
        {helpText && <span className="ml-1 font-normal text-muted-foreground/70">{helpText}</span>}
      </label>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(',', '.'))}
        placeholder={placeholder}
        className={`w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring transition-colors ${
          error ? 'border-red-400 focus:ring-red-300' : 'focus:ring-ring'
        }`}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
