export default function BookmakersLoading() {
  return (
    <div className="space-y-8 animate-pulse">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="h-7 w-44 bg-muted rounded-lg" />
          <div className="h-4 w-56 bg-muted rounded" />
        </div>
        <div className="h-9 w-36 bg-muted rounded-lg" />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-5 shadow-sm space-y-3">
            <div className="h-3 w-20 bg-muted rounded" />
            <div className="h-7 w-24 bg-muted rounded" />
          </div>
        ))}
      </div>

      {/* Bankrolls section */}
      <div className="space-y-3">
        <div className="h-3 w-24 bg-muted rounded" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-muted" />
                <div className="h-4 w-28 bg-muted rounded" />
              </div>
              <div className="h-3 w-40 bg-muted rounded" />
              <div className="flex gap-4">
                <div className="h-6 w-20 bg-muted rounded" />
                <div className="h-6 w-20 bg-muted rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bookmakers list */}
      <div className="space-y-3">
        <div className="h-3 w-32 bg-muted rounded" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-4">
              <div className="w-4 h-4 rounded-full bg-muted shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-32 bg-muted rounded" />
                <div className="h-3 w-48 bg-muted rounded" />
              </div>
              <div className="text-right space-y-1.5">
                <div className="h-4 w-20 bg-muted rounded ml-auto" />
                <div className="h-3 w-14 bg-muted rounded ml-auto" />
              </div>
              <div className="h-6 w-16 bg-muted rounded-full shrink-0" />
            </div>
          </div>
        ))}
      </div>

    </div>
  )
}
