import Link from 'next/link'

export default async function BotPaymentPage({
  searchParams,
}: {
  searchParams?: Promise<{ success?: string; canceled?: string }>
}) {
  const sp       = await (searchParams ?? Promise.resolve({})) as { success?: string; canceled?: string }
  const success  = sp.success === '1'
  const canceled = sp.canceled === '1'

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-sm w-full rounded-2xl border bg-card p-8 text-center space-y-5 shadow-md">
        {success ? (
          <>
            <div className="text-5xl">✅</div>
            <h1 className="text-xl font-bold">¡Pago completado!</h1>
            <p className="text-sm text-muted-foreground">
              Tu suscripción a FidesBot se ha activado. Recibirás una confirmación en Telegram en unos segundos.
            </p>
            <a
              href="https://t.me/FidesAlertBot"
              className="inline-block w-full rounded-xl bg-[#229ED9] text-white px-6 py-3 font-bold text-sm hover:bg-[#1a8bc2] transition-colors"
            >
              Volver a FidesBot →
            </a>
          </>
        ) : canceled ? (
          <>
            <div className="text-5xl">↩️</div>
            <h1 className="text-xl font-bold">Pago cancelado</h1>
            <p className="text-sm text-muted-foreground">
              No se ha realizado ningún cargo. Puedes volver al bot cuando quieras.
            </p>
            <a
              href="https://t.me/FidesAlertBot"
              className="inline-block w-full rounded-xl border px-6 py-3 font-medium text-sm hover:bg-muted transition-colors"
            >
              Volver a FidesBot
            </a>
          </>
        ) : (
          <>
            <div className="text-5xl">💳</div>
            <h1 className="text-xl font-bold">Procesando pago…</h1>
            <p className="text-sm text-muted-foreground">Un momento por favor.</p>
          </>
        )}

        <Link href="/" className="block text-xs text-muted-foreground hover:underline">
          DualStats Tracker
        </Link>
      </div>
    </div>
  )
}
