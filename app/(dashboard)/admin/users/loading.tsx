export default function AdminUsersLoading() {
  return (
    <div className="space-y-6 animate-pulse max-w-5xl">

      {/* Header */}
      <div className="space-y-2">
        <div className="h-7 w-48 bg-muted rounded-lg" />
        <div className="h-4 w-64 bg-muted rounded" />
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-5 space-y-3">
            <div className="h-3 w-20 bg-muted rounded" />
            <div className="h-7 w-16 bg-muted rounded" />
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="rounded-xl border bg-card p-4 flex flex-wrap gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-9 w-32 bg-muted rounded-lg" />
        ))}
      </div>

      {/* Tabla */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 py-3 border-b bg-muted/30">
          <div className="h-4 w-24 bg-muted rounded" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4">
              <div className="h-4 w-32 bg-muted rounded" />
              <div className="h-4 w-24 bg-muted rounded" />
              <div className="h-5 w-16 bg-muted rounded-full ml-auto" />
              <div className="h-8 w-20 bg-muted rounded-lg" />
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}
