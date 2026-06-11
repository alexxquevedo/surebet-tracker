export default function OnboardingLoading() {
  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-pulse">

      {/* Header */}
      <div className="space-y-2">
        <div className="h-7 w-52 bg-muted rounded-lg" />
        <div className="h-4 w-72 bg-muted rounded" />
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-muted shrink-0" />
            <div className="h-3 w-20 bg-muted rounded" />
            {i < 2 && <div className="h-px w-6 bg-muted mx-1" />}
          </div>
        ))}
      </div>

      {/* Step card */}
      <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
        <div className="h-5 w-40 bg-muted rounded" />
        <div className="h-4 w-full bg-muted rounded" />
        <div className="h-4 w-3/4 bg-muted rounded" />

        {/* Bookmaker rows */}
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
            <div className="flex-1 space-y-1.5">
              <div className="h-4 w-28 bg-muted rounded" />
            </div>
            <div className="h-8 w-20 bg-muted rounded-lg" />
            <div className="h-8 w-16 bg-muted rounded-lg" />
          </div>
        ))}

        <div className="h-9 w-32 bg-muted rounded-lg" />
      </div>

    </div>
  )
}
