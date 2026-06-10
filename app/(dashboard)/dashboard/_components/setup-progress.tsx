import Link from 'next/link'

interface Props {
  step1Done: boolean   // has bookmakers
  step2Done: boolean   // all bookmakers have capital
  step3Done: boolean   // telegram linked
}

export function SetupProgress({ step1Done, step2Done, step3Done }: Props) {
  // Banner disappears once core steps are done (step 3 is optional)
  if (step1Done && step2Done) return null

  const steps = [
    {
      label: 'Añade una casa de apuestas',
      done:  step1Done,
    },
    {
      label: 'Registra el capital inicial',
      done:  step2Done,
    },
  ]

  const doneCount = steps.filter((s) => s.done).length

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold">Completa la configuración</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {doneCount}/2 pasos · Tu cuenta necesita estos pasos para funcionar correctamente
          </p>
        </div>
        <Link
          href="/onboarding"
          className="shrink-0 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          Configurar ahora →
        </Link>
      </div>

      {/* Steps */}
      <div className="flex flex-wrap gap-2">
        {steps.map((s, i) => (
          <div
            key={i}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border ${
              s.done
                ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/20 dark:text-green-400 dark:border-green-800'
                : 'bg-background text-muted-foreground border'
            }`}
          >
            <span>{s.done ? '✓' : '○'}</span>
            <span>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
