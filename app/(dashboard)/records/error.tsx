'use client'
import { useEffect } from 'react'

export default function RecordsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => { console.error(error) }, [error])
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 text-center">
      <p className="text-5xl">⚠️</p>
      <h2 className="text-lg font-semibold">No se pudieron cargar las operaciones</h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        Hubo un problema al obtener el historial de apuestas. Inténtalo de nuevo.
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
