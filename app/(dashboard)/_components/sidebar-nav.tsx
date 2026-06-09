'use client'

import { useState, useTransition, useMemo } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import Decimal from 'decimal.js'
import { createQuickBetAction, createMultiLegBetAction } from '@/lib/actions/bet-record'

// ─── Types ───────────────────────────────────────────────────────────────────

interface BookmakerOption {
  id:    string
  name:  string
  color: string | null
}

interface Props {
  bookmakers: BookmakerOption[]
  plan:       string
  userName:   string | null | undefined
  userEmail:  string | null | undefined
  isAdmin:    boolean
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
  { value: 'SINGLE',    label: '⚽ Single',     multi: false },
  { value: 'CASINO',    label: '🎰 Casino',     multi: false },
  { value: 'COMBO',     label: '📋 Combo',      multi: false },
  { value: 'ARBITRAGE', label: '⚡ Surebets',   multi: true  },
  { value: 'MIDDLE',    label: '🎯 Middlebet',  multi: true  },
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

function validateNumber(raw: string, min: number, label: string): string | null {
  if (!raw) return null
  const n = parseFloat(raw)
  if (isNaN(n)) return `${label}: valor inválido`
  if (n < min)  return `${label}: mínimo ${min}`
  return null
}

function defaultDateTime() {
  const now    = new Date()
  const offset = now.getTimezoneOffset()
  const local  = new Date(now.getTime() - offset * 60 * 1000)
  return local.toISOString().slice(0, 16)
}

// ════════════════════════════════════════════════════════════════════════════
// SIDEBAR NAV (Client Component)
// ════════════════════════════════════════════════════════════════════════════

export function SidebarNav({ bookmakers, plan, userName, userEmail, isAdmin }: Props) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

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
              href="/settings?tab=admin"
              className={`flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors ${
                pathname === '/settings' && typeof window !== 'undefined' && window.location.search.includes('tab=admin')
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
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// MODAL DE NUEVA OPERACIÓN
// ════════════════════════════════════════════════════════════════════════════

function NewOperationModal({ bookmakers, onClose }: { bookmakers: BookmakerOption[]; onClose: () => void }) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [betType, setBetType]         = useState<ModalBetType>('SINGLE')
  const isMulti                       = BET_TYPES.find((t) => t.value === betType)?.multi ?? false

  // Shared metadata
  const [selection, setSelection]     = useState('')
  const [sport, setSport]             = useState('')
  const [isLive, setIsLive]           = useState(false)
  const [datePlaced, setDatePlaced]   = useState(defaultDateTime)
  const [middleRange, setMiddleRange] = useState('')

  // Leg 1
  const [bm1Id, setBm1Id]   = useState(bookmakers[0]?.id ?? '')
  const [stake1, setStake1] = useState('')
  const [odds1, setOdds1]   = useState('')

  // Leg 2 (multi only)
  const [bm2Id, setBm2Id]   = useState(bookmakers[1]?.id ?? bookmakers[0]?.id ?? '')
  const [stake2, setStake2] = useState('')
  const [odds2, setOdds2]   = useState('')

  const [isPending, setIsPending] = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [success, setSuccess]     = useState(false)

  // ── Validation ─────────────────────────────────────────────────────────
  const s1err  = validateNumber(stake1, 0.01, 'Stake')
  const o1err  = validateNumber(odds1,  1.01, 'Cuota')
  const s2err  = isMulti ? validateNumber(stake2, 0.01, 'Stake 2') : null
  const o2err  = isMulti ? validateNumber(odds2,  1.01, 'Cuota 2') : null
  const hasErr = !!(s1err || o1err || s2err || o2err)

  // ── Profit preview ──────────────────────────────────────────────────────
  const profitPreview = useMemo(() => {
    const s1n = parseFloat(stake1), o1n = parseFloat(odds1)
    const s2n = parseFloat(stake2), o2n = parseFloat(odds2)
    if (!stake1 || !odds1 || isNaN(s1n) || isNaN(o1n)) return null

    if (!isMulti) {
      const profit = new Decimal(s1n).mul(new Decimal(o1n).minus(1)).toDecimalPlaces(2).toNumber()
      return { label: 'Beneficio estimado si gana', value: profit }
    }
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
  }, [stake1, odds1, stake2, odds2, betType, isMulti])

  // ── Reset ───────────────────────────────────────────────────────────────
  function resetForm() {
    setSelection(''); setSport(''); setIsLive(false); setDatePlaced(defaultDateTime())
    setMiddleRange(''); setStake1(''); setOdds1(''); setStake2(''); setOdds2('')
    setBm1Id(bookmakers[0]?.id ?? ''); setBm2Id(bookmakers[1]?.id ?? bookmakers[0]?.id ?? '')
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
    fd.append('sport',       sport)
    fd.append('isLive',      String(isLive))
    fd.append('datePlaced',  datePlaced)

    let result: { success: boolean; error?: string; id?: string }

    if (isMulti) {
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
          <h2 className="text-lg font-semibold">Nueva Operación</h2>
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

            {/* Evento */}
            <div className="space-y-1.5">
              <label className="block text-sm font-semibold">
                Evento / Selección <span className="font-normal text-muted-foreground">(opcional — se genera auto)</span>
              </label>
              <input type="text" value={selection} onChange={(e) => setSelection(e.target.value)}
                placeholder="ej. Real Madrid vs Barça — 1X2"
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
            </div>

            {/* Deporte (oculto en casino) */}
            {betType !== 'CASINO' && (
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

            {isMulti ? (
              /* ── Multi-leg ─────────────────────────────────────────────── */
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
              /* ── Single-leg ────────────────────────────────────────────── */
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

                <div className="grid grid-cols-2 gap-3">
                  <NumberField label="Stake (€)" value={stake1} onChange={setStake1}
                    placeholder="100.00" step="0.01" min="0.01" error={s1err} />
                  <NumberField label="Cuota" value={odds1} onChange={setOdds1}
                    placeholder="2.10" step="0.01" min="1.01" error={o1err} />
                </div>
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
                      <span className="text-muted-foreground">{profitPreview.worstLabel}</span>
                      <span className={`font-bold tabular-nums ${profitPreview.worst >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {profitPreview.worst >= 0 ? '+' : ''}{profitPreview.worst.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                      </span>
                    </div>
                  </>
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
          placeholder="2.10" step="0.01" min="1.01" error={oddsErr} />
      </div>
    </div>
  )
}

function NumberField({
  label, value, onChange, placeholder, step, min, error,
}: {
  label: string; value: string; onChange: (v: string) => void
  placeholder: string; step: string; min: string; error: string | null
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type="number"
        step={step}
        min={min}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required
        className={`w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring transition-colors ${
          error ? 'border-red-400 focus:ring-red-300' : 'focus:ring-ring'
        }`}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
