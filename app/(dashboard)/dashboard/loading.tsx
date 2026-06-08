// Skeleton que muestra Next.js automáticamente mientras el dashboard carga datos
export default function DashboardLoading() {
  return (
    <div className="space-y-8 animate-pulse">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="h-7 w-28 bg-muted rounded-lg" />
          <div className="h-4 w-44 bg-muted rounded" />
        </div>
      </div>

      {/* KPI cards */}
      <section className="space-y-4">
        <div className="h-3 w-28 bg-muted rounded" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-5 shadow-sm space-y-3">
              <div className="h-3 w-20 bg-muted rounded" />
              <div className="h-7 w-24 bg-muted rounded" />
              <div className="h-3 w-16 bg-muted rounded" />
            </div>
          ))}
        </div>
        {/* Rentabilidad card */}
        <div className="rounded-xl border bg-card p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="h-3 w-32 bg-muted rounded" />
              <div className="h-10 w-24 bg-muted rounded" />
            </div>
            <div className="flex gap-8">
              <div className="space-y-2">
                <div className="h-3 w-24 bg-muted rounded" />
                <div className="h-7 w-16 bg-muted rounded" />
              </div>
              <div className="space-y-2">
                <div className="h-3 w-24 bg-muted rounded" />
                <div className="h-7 w-16 bg-muted rounded" />
              </div>
            </div>
          </div>
          <div className="h-2.5 rounded-full bg-muted" />
        </div>
        {/* Chart */}
        <div className="rounded-lg border bg-card p-5 space-y-3">
          <div className="h-3 w-40 bg-muted rounded" />
          <div className="h-3 w-56 bg-muted rounded" />
          <div className="h-32 bg-muted/50 rounded-lg" />
        </div>
      </section>

      {/* Estrategia + Casas */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <section className="lg:col-span-3 space-y-3">
          <div className="h-3 w-40 bg-muted rounded" />
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5 border-b last:border-b-0">
                <div className="h-6 w-20 bg-muted rounded-full" />
                <div className="flex-1 h-4 bg-muted rounded" />
                <div className="h-4 w-16 bg-muted rounded" />
                <div className="h-4 w-12 bg-muted rounded" />
              </div>
            ))}
          </div>
        </section>
        <section className="lg:col-span-2 space-y-3">
          <div className="h-3 w-32 bg-muted rounded" />
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border bg-card px-4 py-3 flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-muted shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-20 bg-muted rounded" />
                  <div className="h-3 w-28 bg-muted rounded" />
                </div>
                <div className="text-right space-y-1.5">
                  <div className="h-4 w-16 bg-muted rounded" />
                  <div className="h-3 w-10 bg-muted rounded ml-auto" />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Últimas operaciones */}
      <section className="space-y-3">
        <div className="h-3 w-36 bg-muted rounded" />
        <div className="rounded-lg border bg-card overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4 border-b last:border-b-0">
              <div className="hidden sm:block h-6 w-16 bg-muted rounded-full shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-36 bg-muted rounded" />
                <div className="h-3 w-24 bg-muted rounded" />
              </div>
              <div className="text-right space-y-1.5 shrink-0">
                <div className="h-4 w-16 bg-muted rounded ml-auto" />
                <div className="h-5 w-14 bg-muted rounded-full ml-auto" />
              </div>
            </div>
          ))}
        </div>
      </section>

    </div>
  )
}
