export default function RecordsLoading() {
  return (
    <div className="space-y-6 animate-pulse">

      {/* Header */}
      <div className="space-y-2">
        <div className="h-7 w-32 bg-muted rounded-lg" />
        <div className="h-4 w-56 bg-muted rounded" />
      </div>

      {/* Date range presets */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="h-3 w-16 bg-muted rounded" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-7 w-24 bg-muted rounded-lg" />
          ))}
          <div className="h-7 w-64 bg-muted rounded-lg" />
        </div>
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <div className="h-3 w-16 bg-muted rounded" />
            <div className="h-8 w-32 bg-muted rounded-lg" />
          </div>
        ))}
      </div>

      {/* Table skeleton (desktop) */}
      <div className="hidden md:block rounded-xl border bg-card overflow-hidden shadow-sm">
        {/* Header row */}
        <div className="flex gap-4 px-4 py-3 border-b bg-muted/40">
          {[80, 160, 120, 100, 80, 80, 80, 40].map((w, i) => (
            <div key={i} className="h-3 bg-muted rounded" style={{ width: w }} />
          ))}
        </div>
        {/* Data rows */}
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3.5 border-b last:border-b-0">
            <div className="h-5 w-20 bg-muted rounded-full shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-4 w-40 bg-muted rounded" />
              <div className="h-3 w-24 bg-muted rounded" />
            </div>
            <div className="h-5 w-16 bg-muted rounded-full" />
            <div className="h-4 w-16 bg-muted rounded ml-auto" />
            <div className="h-4 w-16 bg-muted rounded" />
            <div className="h-4 w-14 bg-muted rounded" />
          </div>
        ))}
      </div>

      {/* Cards skeleton (móvil) */}
      <div className="md:hidden space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card overflow-hidden shadow-sm">
            <div className="flex items-start justify-between gap-3 px-4 py-3 border-b bg-muted/20">
              <div className="space-y-1.5 flex-1">
                <div className="h-4 w-40 bg-muted rounded" />
                <div className="h-3 w-20 bg-muted rounded" />
              </div>
              <div className="h-6 w-16 bg-muted rounded-full shrink-0" />
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <div className="space-y-1.5">
                <div className="h-4 w-28 bg-muted rounded" />
                <div className="h-3 w-20 bg-muted rounded" />
              </div>
              <div className="h-5 w-16 bg-muted rounded" />
            </div>
          </div>
        ))}
      </div>

    </div>
  )
}
