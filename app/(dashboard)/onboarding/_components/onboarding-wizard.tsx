'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { addPresetBookmakerAction, setInitialCapitalAction } from '@/lib/actions/bookmaker'
import { generateLinkTokenAction } from '@/lib/actions/telegram'
import { BOOKMAKER_PRESETS } from '@/lib/utils/bookmakers-preset'
import type { BookmakerPreset } from '@/lib/utils/bookmakers-preset'

interface Bookmaker {
  id:             string
  name:           string
  etiqueta:       string | null
  initialCapital: number | null
}

interface Props {
  step1Done:  boolean
  step2Done:  boolean
  step3Done:  boolean
  bookmakers: Bookmaker[]
  plan:       string
}

// ── Helpers ────────────────────────────────────────────────────────────────

const isPro = (plan: string) => ['PRO', 'PRO_TRACKER', 'ENTERPRISE'].includes(plan)

function StepBadge({ n, done, active }: { n: number; done: boolean; active: boolean }) {
  if (done) return (
    <span className="flex items-center justify-center w-8 h-8 rounded-full bg-green-500 text-white text-sm font-bold shrink-0">
      ✓
    </span>
  )
  return (
    <span className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold shrink-0 border-2 ${
      active
        ? 'border-primary bg-primary text-primary-foreground'
        : 'border-muted-foreground/30 text-muted-foreground'
    }`}>
      {n}
    </span>
  )
}

// ── Step 1 — Add bookmakers (one or many) ─────────────────────────────────

function Step1({ bookmakers, onDone }: { bookmakers: Bookmaker[]; onDone: () => void }) {
  const [selected,  setSelected]  = useState<BookmakerPreset | null>(null)
  const [balance,   setBalance]   = useState('')
  const [error,     setError]     = useState<string | null>(null)
  const [pending,   start]        = useTransition()
  const [showAll,   setShowAll]   = useState(false)
  const router = useRouter()

  const presets = showAll ? BOOKMAKER_PRESETS : BOOKMAKER_PRESETS.slice(0, 8)

  function handleAdd() {
    if (!selected) return
    const bal = parseFloat(balance)
    if (isNaN(bal) || bal < 0) { setError('Introduce un saldo válido (≥ 0)'); return }
    start(async () => {
      const r = await addPresetBookmakerAction(selected, bal)
      if (r.success) {
        router.refresh()
        setSelected(null)
        setBalance('')
        setError(null)
      } else {
        setError(r.error)
      }
    })
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Selecciona todas las casas en las que tienes saldo. Puedes añadir cuantas quieras antes de continuar.
      </p>

      {/* Already added */}
      {bookmakers.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Casas añadidas</p>
          <div className="flex flex-wrap gap-2">
            {bookmakers.map((b) => (
              <span
                key={b.id}
                className="flex items-center gap-1.5 rounded-full bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/20 dark:text-green-400 dark:border-green-800 px-3 py-1 text-xs font-medium"
              >
                ✓ {b.etiqueta ? `${b.name} · ${b.etiqueta}` : b.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Preset grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {presets.map((p) => (
          <button
            key={p.name}
            onClick={() => setSelected(p)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm text-left transition-all ${
              selected?.name === p.name
                ? 'border-primary ring-1 ring-primary bg-primary/5'
                : 'border hover:border-primary/50 hover:bg-muted/50'
            }`}
          >
            <span
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: p.color }}
            />
            <span className="font-medium truncate text-xs">{p.name}</span>
          </button>
        ))}
      </div>

      {!showAll && BOOKMAKER_PRESETS.length > 8 && (
        <button
          onClick={() => setShowAll(true)}
          className="text-xs text-primary hover:underline"
        >
          Ver todas las casas ({BOOKMAKER_PRESETS.length}) →
        </button>
      )}

      {/* Balance input */}
      {selected && (
        <div className="flex items-end gap-3 pt-1">
          <div className="space-y-1 flex-1">
            <label className="text-xs font-medium text-muted-foreground">
              Saldo actual en {selected.name}
            </label>
            <input
              type="number" min="0" step="0.01"
              value={balance}
              onChange={(e) => { setBalance(e.target.value); setError(null) }}
              placeholder="500"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button
            onClick={handleAdd}
            disabled={pending || !balance}
            className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors shrink-0"
          >
            {pending ? 'Añadiendo…' : 'Añadir'}
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      {/* Continue — only visible once at least one bookmaker added */}
      {bookmakers.length > 0 && (
        <div className="flex items-center justify-between pt-2 border-t">
          <p className="text-xs text-muted-foreground">
            {bookmakers.length === 1 ? '1 casa añadida' : `${bookmakers.length} casas añadidas`}
          </p>
          <button
            onClick={onDone}
            className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Siguiente paso →
          </button>
        </div>
      )}
    </div>
  )
}

// ── Step 2 — Set initial capital ────────────────────────────────────────────

function Step2({ bookmakers, onDone }: { bookmakers: Bookmaker[]; onDone: () => void }) {
  const pending_bms = bookmakers.filter((b) => b.initialCapital === null)
  const [amounts,  setAmounts]  = useState<Record<string, string>>({})
  const [errors,   setErrors]   = useState<Record<string, string>>({})
  const [success,  setSuccess]  = useState<Record<string, boolean>>({})
  const [pending,  start]       = useTransition()
  const router = useRouter()

  const bmName = (b: Bookmaker) => b.etiqueta ? `${b.name} · ${b.etiqueta}` : b.name

  function handleSave(b: Bookmaker) {
    const raw = parseFloat(amounts[b.id] ?? '')
    if (isNaN(raw) || raw < 0) {
      setErrors((e) => ({ ...e, [b.id]: 'Introduce un importe válido' }))
      return
    }
    start(async () => {
      const r = await setInitialCapitalAction(b.id, raw)
      if (r.success) {
        setSuccess((s) => ({ ...s, [b.id]: true }))
        router.refresh()
        // If all pending set, move on
        const stillPending = pending_bms.filter(
          (pb) => pb.id !== b.id && !success[pb.id]
        )
        if (stillPending.length === 0) onDone()
      } else {
        setErrors((e) => ({ ...e, [b.id]: r.error }))
      }
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        El capital inicial es el saldo que tenías en cada casa al empezar a usar DualStats.
        Es imprescindible para que el sistema de apuestas funcione correctamente.
      </p>
      {pending_bms.map((b) => (
        <div key={b.id} className={`flex items-center gap-3 rounded-lg border p-3 ${success[b.id] ? 'border-green-300 bg-green-50 dark:bg-green-950/20' : ''}`}>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{bmName(b)}</p>
            {errors[b.id] && <p className="text-xs text-red-600 mt-0.5">{errors[b.id]}</p>}
          </div>
          {success[b.id] ? (
            <span className="text-green-600 text-sm font-medium">✓ Guardado</span>
          ) : (
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number" min="0" step="0.01"
                value={amounts[b.id] ?? ''}
                onChange={(e) => {
                  setAmounts((a) => ({ ...a, [b.id]: e.target.value }))
                  setErrors((er) => ({ ...er, [b.id]: '' }))
                }}
                placeholder="€"
                className="w-20 rounded-lg border bg-background px-2 py-1.5 text-sm text-right outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                onClick={() => handleSave(b)}
                disabled={pending || !amounts[b.id]}
                className="rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
              >
                Guardar
              </button>
            </div>
          )}
        </div>
      ))}
      {pending_bms.length === 0 && (
        <p className="text-sm text-green-600 font-medium">✓ Todas las casas tienen capital registrado</p>
      )}
    </div>
  )
}

// ── Step 3 — Link Telegram ──────────────────────────────────────────────────

function Step3({ plan }: { plan: string }) {
  const [linkData, setLinkData] = useState<{ deepLink: string; manualToken: string } | null>(null)
  const [copied,   setCopied]   = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [pending,  start]       = useTransition()

  function handleGenerate() {
    start(async () => {
      const r = await generateLinkTokenAction()
      if (r.success) setLinkData({ deepLink: r.deepLink, manualToken: r.manualToken })
      else setError(r.error)
    })
  }

  function copyToken() {
    if (!linkData) return
    void navigator.clipboard.writeText(linkData.manualToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!isPro(plan)) {
    return (
      <div className="rounded-lg bg-muted/50 border border-dashed p-4 text-sm text-muted-foreground">
        🔒 La vinculación con FidesBot requiere el plan <strong>PRO</strong> o superior.
        Puedes actualizarlo en{' '}
        <a href="/settings?tab=suscripcion" className="text-primary underline">Configuración → Suscripción</a>.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Vincula tu cuenta de Telegram con FidesBot para recibir alertas de surebets
        y que tus apuestas se registren automáticamente.
      </p>

      {!linkData ? (
        <button
          onClick={handleGenerate}
          disabled={pending}
          className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
        >
          {pending ? 'Generando enlace…' : '🔗 Generar enlace de vinculación'}
        </button>
      ) : (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground font-medium">Enlace generado (válido 10 min)</p>
          <a
            href={linkData.deepLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-4 py-2.5 text-sm font-medium hover:bg-primary/90 transition-colors w-fit"
          >
            📱 Abrir FidesBot en Telegram
          </a>
          <p className="text-xs text-muted-foreground">¿Prefieres el token manual?</p>
          <div className="flex items-center gap-2">
            <code className="text-xs bg-muted rounded px-2 py-1 font-mono flex-1 truncate">
              {linkData.manualToken}
            </code>
            <button
              onClick={copyToken}
              className="shrink-0 text-xs px-2 py-1 rounded border hover:bg-muted transition-colors"
            >
              {copied ? '✓' : 'Copiar'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
    </div>
  )
}

// ── Main wizard ────────────────────────────────────────────────────────────

export function OnboardingWizard({ step1Done, step2Done, step3Done, bookmakers, plan }: Props) {
  const [localStep1, setLocalStep1] = useState(step1Done)
  const [localStep2, setLocalStep2] = useState(step2Done)

  // Only core steps (1+2) determine the current active step
  const currentStep = !localStep1 ? 1 : !localStep2 ? 2 : 0

  const coreSteps = [
    {
      n:    1,
      done: localStep1,
      label: 'Añade tu primera casa de apuestas',
      sub:  'Registra una casa con tu saldo actual',
    },
    {
      n:    2,
      done: localStep2,
      label: 'Registra el capital inicial',
      sub:  'Necesario para que el sistema de apuestas funcione',
    },
  ]

  // Core done = steps 1+2 complete (step 3 is optional)
  const coreDone = localStep1 && localStep2

  return (
    <div className="max-w-2xl mx-auto space-y-6 py-4">

      {/* Header */}
      <div className="text-center space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">
          {coreDone ? '🎉 ¡Listo para empezar!' : '👋 Bienvenido a DualStats Tracker'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {coreDone
            ? 'Tu cuenta está configurada. Puedes vincular FidesBot cuando quieras o ir directo al Dashboard.'
            : 'Completa estos 2 pasos para empezar a trackear tu bankroll correctamente.'}
        </p>
      </div>

      {/* Progress pills — only core steps */}
      <div className="flex items-center justify-center gap-2">
        {coreSteps.map((s) => (
          <div key={s.n} className="flex items-center gap-2">
            <div className={`h-2 rounded-full transition-all ${
              s.done ? 'bg-green-500 w-8' : currentStep === s.n ? 'bg-primary w-8' : 'bg-muted w-5'
            }`} />
          </div>
        ))}
        <span className="text-xs text-muted-foreground ml-1">
          {coreSteps.filter(s => s.done).length}/2 completados
        </span>
      </div>

      {/* Steps */}
      <div className="space-y-3">
        {coreSteps.map((s) => {
          const isActive = currentStep === s.n && !s.done
          const isLocked = !s.done && currentStep < s.n

          return (
            <div
              key={s.n}
              className={`rounded-xl border bg-card shadow-sm transition-all ${
                s.done
                  ? 'border-green-200 dark:border-green-800 opacity-75'
                  : isActive
                    ? 'border-primary/40 ring-1 ring-primary/20'
                    : 'border opacity-50'
              }`}
            >
              {/* Step header */}
              <div className="flex items-center gap-3 px-5 py-4">
                <StepBadge n={s.n} done={s.done} active={isActive} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-semibold ${s.done ? 'line-through text-muted-foreground' : ''}`}>
                    {s.label}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{s.sub}</p>
                </div>
                {s.done && (
                  <span className="text-xs font-medium text-green-600 shrink-0">Completado</span>
                )}
                {isLocked && (
                  <span className="text-xs text-muted-foreground shrink-0">🔒</span>
                )}
              </div>

              {/* Step content (only active step) */}
              {isActive && (
                <div className="px-5 pb-5 pt-0 border-t">
                  <div className="pt-4">
                    {s.n === 1 && <Step1 bookmakers={bookmakers} onDone={() => setLocalStep1(true)} />}
                    {s.n === 2 && <Step2 bookmakers={bookmakers} onDone={() => setLocalStep2(true)} />}
                    {s.n === 3 && <Step3 plan={plan} />}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Optional Step 3 — FidesBot */}
      <div className={`rounded-xl border bg-card shadow-sm transition-all ${
        step3Done
          ? 'border-green-200 dark:border-green-800 opacity-75'
          : coreDone
            ? 'border-primary/20'
            : 'border opacity-40 pointer-events-none'
      }`}>
        <div className="flex items-center gap-3 px-5 py-4">
          <StepBadge n={3} done={step3Done} active={coreDone && !step3Done} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className={`text-sm font-semibold ${step3Done ? 'line-through text-muted-foreground' : ''}`}>
                Vincula FidesBot
              </p>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Opcional
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Conecta Telegram para recibir alertas y registrar apuestas automáticamente
            </p>
          </div>
          {step3Done && (
            <span className="text-xs font-medium text-green-600 shrink-0">Completado</span>
          )}
        </div>
        {coreDone && !step3Done && (
          <div className="px-5 pb-5 pt-0 border-t">
            <div className="pt-4">
              <Step3 plan={plan} />
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-2">
        {!coreDone && (
          <a
            href="/dashboard"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Saltar por ahora →
          </a>
        )}
        {coreDone && (
          <a
            href="/dashboard"
            className="ml-auto rounded-lg bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            Ir al Dashboard →
          </a>
        )}
      </div>
    </div>
  )
}
