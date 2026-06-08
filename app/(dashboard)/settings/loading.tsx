export default function SettingsLoading() {
  return (
    <div className="space-y-8 animate-pulse max-w-2xl">

      {/* Header */}
      <div className="space-y-2">
        <div className="h-7 w-36 bg-muted rounded-lg" />
        <div className="h-4 w-48 bg-muted rounded" />
      </div>

      {/* Sección perfil */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="h-4 w-24 bg-muted rounded" />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="h-3 w-20 bg-muted rounded" />
              <div className="h-9 w-full bg-muted rounded-lg" />
            </div>
          ))}
        </div>
        <div className="h-9 w-32 bg-muted rounded-lg" />
      </div>

      {/* Sección notificaciones */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="h-4 w-32 bg-muted rounded" />
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between py-2">
            <div className="space-y-1.5">
              <div className="h-4 w-48 bg-muted rounded" />
              <div className="h-3 w-64 bg-muted rounded" />
            </div>
            <div className="h-6 w-10 bg-muted rounded-full shrink-0" />
          </div>
        ))}
      </div>

      {/* Sección API keys */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-4 w-24 bg-muted rounded" />
          <div className="h-8 w-28 bg-muted rounded-lg" />
        </div>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-1.5">
              <div className="h-4 w-32 bg-muted rounded" />
              <div className="h-3 w-48 bg-muted rounded" />
            </div>
            <div className="h-7 w-16 bg-muted rounded-lg shrink-0" />
          </div>
        ))}
      </div>

    </div>
  )
}
