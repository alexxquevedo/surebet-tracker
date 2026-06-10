import { ThemeToggle } from '@/components/ui/theme-toggle'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      {/* Theme toggle — esquina superior derecha */}
      <div className="fixed top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">DualStats Tracker</h1>
        <p className="text-sm text-muted-foreground mt-1">
          La herramienta profesional de arbitraje deportivo
        </p>
      </div>
      {children}
    </div>
  )
}
