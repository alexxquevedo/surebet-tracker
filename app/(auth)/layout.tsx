export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Surebet Tracker Pro</h1>
        <p className="text-sm text-muted-foreground mt-1">
          La herramienta profesional de arbitraje deportivo
        </p>
      </div>
      {children}
    </div>
  )
}
