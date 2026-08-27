export default function ScannerLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="h-7 w-24 bg-muted rounded-lg" />
          <div className="h-4 w-56 bg-muted rounded" />
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 shadow-sm space-y-2">
            <div className="h-3 w-20 bg-muted rounded" />
            <div className="h-6 w-12 bg-muted rounded" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-4 py-3.5 border-b last:border-b-0">
            <div className="flex items-start gap-3">
              <div className="h-5 w-16 bg-muted rounded-full shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-48 bg-muted rounded" />
                <div className="h-3 w-32 bg-muted rounded" />
                <div className="flex gap-1.5">
                  <div className="h-5 w-20 bg-muted rounded-md" />
                  <div className="h-5 w-20 bg-muted rounded-md" />
                </div>
              </div>
              <div className="text-right space-y-1 shrink-0">
                <div className="h-5 w-12 bg-muted rounded ml-auto" />
                <div className="h-3 w-10 bg-muted rounded ml-auto" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
