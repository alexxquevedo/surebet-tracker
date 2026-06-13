'use client'
import { useEffect, useState } from 'react'

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [retried, setRetried] = useState(false)

  useEffect(() => { console.error(error) }, [error])

  useEffect(() => {
    if (retried) return
    const t = setTimeout(() => { setRetried(true); reset() }, 1500)
    return () => clearTimeout(t)
  }, [reset, retried])

  if (!retried) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3 text-center">
        <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 text-center">
      <p className="text-5xl">⚠️</p>
      <h2 className="text-lg font-semibold">No se pudo cargar la configuración</h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        Hubo un problema al cargar tus ajustes. Inténtalo de nuevo.
      </p>
      <button
        onClick={reset}
        className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
      >
        Reintentar
      </button>
    </div>
  )
}
