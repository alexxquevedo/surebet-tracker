'use client'

import { useState, useCallback } from 'react'

// ── Arb math helpers ─────────────────────────────────────────────────────────

function calcSurebet(legs: { odds: number }[], totalStake: number) {
  const invOdds = legs.map((l) => (l.odds > 1 ? 1 / l.odds : 0))
  const sumInv  = invOdds.reduce((a, b) => a + b, 0)
  if (sumInv === 0) return null

  const guarantee  = totalStake / sumInv           // equal return from every leg
  const profitAmt  = guarantee - totalStake
  const profitPct  = (profitAmt / totalStake) * 100
  const isArb      = sumInv < 1
  const stakes     = invOdds.map((p) => p * guarantee)

  return { isArb, profitAmt, profitPct, guarantee, stakes, sumInv }
}

function calcMiddle(
  legs: { odds: number; stake: number }[],
) {
  if (legs.length < 2) return null
  const [a, b] = legs
  if (!a || !b) return null

  const returnA   = a.stake * a.odds
  const returnB   = b.stake * b.odds
  const total     = a.stake + b.stake
  const bestCase  = returnA - a.stake + returnB - b.stake       // both win
  const worseCaseA = returnA - total                            // A wins, B loses
  const worseCaseB = returnB - total                            // B wins, A loses
  const worstCase = Math.min(worseCaseA, worseCaseB)

  return { total, bestCase, worseCaseA, worseCaseB, worstCase, returnA, returnB }
}

// ── Formatters ───────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  (n >= 0 ? '+' : '') + n.toFixed(2) + ' €'
const fmtAbs = (n: number) => n.toFixed(2) + ' €'
const fmtPct = (n: number) =>
  (n >= 0 ? '+' : '') + n.toFixed(3) + '%'

function cls(n: number) {
  return n > 0 ? 'text-green-600' : n < 0 ? 'text-red-600' : 'text-muted-foreground'
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
      {children}
    </p>
  )
}

function Input({
  value,
  onChange,
  placeholder,
  step = '0.01',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  step?: string
}) {
  return (
    <input
      type="number"
      value={value}
      step={step}
      min="0"
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border bg-background px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40"
    />
  )
}

function ResultRow({
  label,
  value,
  valueCls = '',
}: {
  label: string
  value: string
  valueCls?: string
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${valueCls}`}>{value}</span>
    </div>
  )
}

// ── Surebet tab ───────────────────────────────────────────────────────────────

interface SurebetLeg { odds: string; label: string }

function SurebetCalculator() {
  const [legs, setLegs] = useState<SurebetLeg[]>([
    { odds: '', label: '' },
    { odds: '', label: '' },
  ])
  const [totalStake, setTotalStake] = useState('100')

  const updateLeg = useCallback(
    (i: number, field: keyof SurebetLeg, value: string) => {
      setLegs((prev) => {
        const next = [...prev]
        next[i] = { ...next[i]!, [field]: value }
        return next
      })
    },
    [],
  )

  const addLeg = () =>
    setLegs((prev) => [...prev, { odds: '', label: '' }])
  const removeLeg = (i: number) =>
    setLegs((prev) => prev.filter((_, idx) => idx !== i))

  const parsedLegs = legs.map((l) => ({ odds: parseFloat(l.odds) || 0 }))
  const stake = parseFloat(totalStake) || 0
  const allValid = parsedLegs.every((l) => l.odds > 1) && stake > 0
  const result = allValid ? calcSurebet(parsedLegs, stake) : null

  return (
    <div className="space-y-6">
      {/* Stake */}
      <div>
        <Label>Stake total (€)</Label>
        <Input value={totalStake} onChange={setTotalStake} placeholder="100" step="1" />
      </div>

      {/* Legs */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Piernas</Label>
          {legs.length < 4 && (
            <button
              onClick={addLeg}
              className="text-xs text-primary hover:underline"
            >
              + Añadir pierna
            </button>
          )}
        </div>

        {legs.map((leg, i) => (
          <div key={i} className="rounded-xl border bg-muted/30 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">
                Pierna {i + 1}
              </span>
              {legs.length > 2 && (
                <button
                  onClick={() => removeLeg(i)}
                  className="text-xs text-muted-foreground hover:text-red-500"
                >
                  Eliminar
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Casa (opcional)</Label>
                <Input
                  value={leg.label}
                  onChange={(v) => updateLeg(i, 'label', v)}
                  placeholder="Winamax"
                />
              </div>
              <div>
                <Label>Cuota</Label>
                <Input
                  value={leg.odds}
                  onChange={(v) => updateLeg(i, 'odds', v)}
                  placeholder="2.10"
                  step="0.01"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Results */}
      {result !== null ? (
        <div className={`rounded-xl border p-4 ${result.isArb ? 'border-green-300 bg-green-50 dark:bg-green-950/30' : 'border-red-200 bg-red-50 dark:bg-red-950/30'}`}>
          <p className={`text-sm font-bold mb-3 ${result.isArb ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {result.isArb ? 'Arbitraje detectado' : 'Sin arbitraje — el margen de las casas es positivo'}
          </p>

          <div className="divide-y">
            {legs.map((leg, i) => (
              <ResultRow
                key={i}
                label={`Pierna ${i + 1}${leg.label ? ` (${leg.label})` : ''} — cuota ${leg.odds}`}
                value={fmtAbs(result.stakes[i] ?? 0)}
              />
            ))}
            <ResultRow
              label="Retorno garantizado"
              value={fmtAbs(result.guarantee)}
            />
            <ResultRow
              label="Beneficio neto"
              value={fmt(result.profitAmt)}
              valueCls={cls(result.profitAmt)}
            />
            <ResultRow
              label="Margen"
              value={fmtPct(result.profitPct)}
              valueCls={cls(result.profitPct)}
            />
            <ResultRow
              label="Suma de prob. implícitas"
              value={`${(result.sumInv * 100).toFixed(2)}%`}
              valueCls={result.isArb ? 'text-green-600' : 'text-red-600'}
            />
          </div>
        </div>
      ) : (
        <div className="rounded-xl border bg-muted/20 p-4 text-center text-sm text-muted-foreground">
          Introduce las cuotas y el stake para calcular
        </div>
      )}
    </div>
  )
}

// ── Middle tab ────────────────────────────────────────────────────────────────

interface MiddleLeg { odds: string; stake: string; label: string }

function MiddleCalculator() {
  const [legs, setLegs] = useState<MiddleLeg[]>([
    { odds: '', stake: '', label: '' },
    { odds: '', stake: '', label: '' },
  ])
  const [autoBalance, setAutoBalance] = useState(true)
  const [totalStake, setTotalStake] = useState('100')

  const updateLeg = useCallback(
    (i: number, field: keyof MiddleLeg, value: string) => {
      setLegs((prev) => {
        const next = [...prev]
        next[i] = { ...next[i]!, [field]: value }
        return next
      })
    },
    [],
  )

  // Auto-balance: distribute stake proportionally so worst cases are equal
  const getEffectiveLegs = (): { odds: number; stake: number }[] => {
    if (!autoBalance) {
      return legs.map((l) => ({
        odds:  parseFloat(l.odds)  || 0,
        stake: parseFloat(l.stake) || 0,
      }))
    }
    // Balanced stakes: stake_i proportional to 1/odds_i
    const total = parseFloat(totalStake) || 0
    const parsed = legs.map((l) => parseFloat(l.odds) || 0)
    const sumInv = parsed.reduce((a, o) => a + (o > 1 ? 1 / o : 0), 0)
    if (sumInv === 0) return legs.map(() => ({ odds: 0, stake: 0 }))
    return parsed.map((o) => ({
      odds:  o,
      stake: o > 1 ? (1 / o / sumInv) * total : 0,
    }))
  }

  const effectiveLegs = getEffectiveLegs()
  const allValid = effectiveLegs.every((l) => l.odds > 1 && l.stake > 0)
  const result = allValid ? calcMiddle(effectiveLegs) : null

  return (
    <div className="space-y-6">
      {/* Auto-balance toggle */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setAutoBalance((v) => !v)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            autoBalance ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
              autoBalance ? 'translate-x-4' : 'translate-x-1'
            }`}
          />
        </button>
        <span className="text-sm">
          Equilibrar stakes automáticamente (worst case igualado)
        </span>
      </div>

      {/* Total stake (only shown when auto-balance on) */}
      {autoBalance && (
        <div>
          <Label>Stake total (€)</Label>
          <Input value={totalStake} onChange={setTotalStake} placeholder="100" step="1" />
        </div>
      )}

      {/* Legs */}
      <div className="space-y-3">
        <Label>Piernas</Label>
        {legs.map((leg, i) => (
          <div key={i} className="rounded-xl border bg-muted/30 p-3 space-y-2">
            <span className="text-xs font-semibold text-muted-foreground">Pierna {i + 1}</span>
            <div className={`grid gap-2 ${autoBalance ? 'grid-cols-2' : 'grid-cols-3'}`}>
              <div>
                <Label>Casa (opcional)</Label>
                <Input
                  value={leg.label}
                  onChange={(v) => updateLeg(i, 'label', v)}
                  placeholder="Codere"
                />
              </div>
              <div>
                <Label>Cuota</Label>
                <Input
                  value={leg.odds}
                  onChange={(v) => updateLeg(i, 'odds', v)}
                  placeholder="1.95"
                  step="0.01"
                />
              </div>
              {!autoBalance && (
                <div>
                  <Label>Stake (€)</Label>
                  <Input
                    value={leg.stake}
                    onChange={(v) => updateLeg(i, 'stake', v)}
                    placeholder="50"
                    step="1"
                  />
                </div>
              )}
            </div>
            {autoBalance && effectiveLegs[i] && effectiveLegs[i]!.stake > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Stake sugerido: {fmtAbs(effectiveLegs[i]!.stake)}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Results */}
      {result !== null ? (
        <div className="rounded-xl border bg-card p-4 space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Escenarios</p>
          <div className="divide-y">
            <ResultRow
              label="Stake total"
              value={fmtAbs(result.total)}
            />
            <ResultRow
              label="Middle entra (ambas ganan)"
              value={fmt(result.bestCase)}
              valueCls={cls(result.bestCase)}
            />
            <ResultRow
              label="Solo pierna 1 gana"
              value={fmt(result.worseCaseA)}
              valueCls={cls(result.worseCaseA)}
            />
            <ResultRow
              label="Solo pierna 2 gana"
              value={fmt(result.worseCaseB)}
              valueCls={cls(result.worseCaseB)}
            />
            <ResultRow
              label="Peor escenario"
              value={fmt(result.worstCase)}
              valueCls={cls(result.worstCase)}
            />
          </div>
        </div>
      ) : (
        <div className="rounded-xl border bg-muted/20 p-4 text-center text-sm text-muted-foreground">
          Introduce las cuotas para calcular los escenarios
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CalculatorPage() {
  const [tab, setTab] = useState<'surebet' | 'middle'>('surebet')

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Calculadora</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Calcula stakes óptimos y beneficio garantizado
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-xl border bg-muted/30 p-1">
        {(
          [
            { id: 'surebet', label: 'Surebet / Arbitraje' },
            { id: 'middle',  label: 'Middle' },
          ] as const
        ).map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
              tab === id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Panel */}
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        {tab === 'surebet' ? <SurebetCalculator /> : <MiddleCalculator />}
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Los cálculos son orientativos. Verifica siempre las cuotas antes de apostar.
      </p>
    </div>
  )
}
