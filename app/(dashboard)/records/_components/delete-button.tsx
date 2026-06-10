'use client'

import { useState, useTransition } from 'react'
import { Trash2 } from 'lucide-react'
import { deleteOperationAction } from '@/lib/actions/bet-record'
import { useRouter } from 'next/navigation'

interface DeleteButtonProps {
  betRecordId: string
}

export function DeleteButton({ betRecordId }: DeleteButtonProps) {
  const [open, setOpen]           = useState(false)
  const [isPending, startTransition] = useTransition()
  const router                    = useRouter()

  function handleConfirm() {
    startTransition(async () => {
      const result = await deleteOperationAction(betRecordId)
      if (result.success) {
        setOpen(false)
        router.refresh()
      } else {
        alert(result.error)
      }
    })
  }

  return (
    <>
      {/* Trigger */}
      <button
        onClick={() => setOpen(true)}
        title="Eliminar operación"
        className="inline-flex items-center justify-center rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      {/* Confirmation modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => !isPending && setOpen(false)}
          />

          {/* Dialog */}
          <div className="relative z-10 w-full max-w-sm rounded-xl border bg-card p-6 shadow-xl mx-4">
            <div className="mb-4 flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <Trash2 className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-base font-semibold leading-tight">Eliminar operación</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  ¿Estás seguro que quieres eliminar esta operación?{' '}
                  <span className="font-medium text-foreground">
                    Esta acción no podrá deshacerse.
                  </span>
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setOpen(false)}
                disabled={isPending}
                className="rounded-lg border px-4 py-1.5 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirm}
                disabled={isPending}
                className="rounded-lg bg-destructive px-4 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50"
              >
                {isPending ? 'Eliminando…' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
