export default function StatsLoading() {
  return (
    <div className="space-y-8 animate-pulse max-w-4xl">

      {/* Header */}
      <div className="space-y-2">
        <div className="h-7 w-40 bg-muted rounded-lg" />
        <div className="h-4 w-56 bg-muted rounded" />
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-5 space-y-3">
            <div className="h-3 w-20 bg-muted rounded" />
            <div className="h-7 w-24 bg-muted rounded" />
          </div>
        ))}
      </div>

      {/* Distribution + Sport side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-5 space-y-4">
            <div className="h-4 w-32 bg-muted rounded" />
            <div className="h-48 bg-muted rounded-lg" />
          </div>
        ))}
      </div>

      {/* Bookmaker bars */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div className="h-4 w-40 bg-muted rounded" />
        <div className="h-48 bg-muted rounded-lg" />
      </div>

    </div>
  )
}
