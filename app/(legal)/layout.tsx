import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: { template: '%s — DualStats Tracker', default: 'DualStats Tracker' },
}

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      {/* Minimal topbar */}
      <header className="border-b bg-card">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/dashboard" className="text-sm font-bold tracking-tight hover:opacity-80 transition-opacity">
            DualStats Tracker
          </Link>
          <Link
            href="/dashboard"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Volver al Dashboard
          </Link>
        </div>
      </header>

      {/* Page content */}
      <main className="max-w-3xl mx-auto px-6 py-12">{children}</main>

      {/* Footer */}
      <footer className="border-t mt-16">
        <div className="max-w-3xl mx-auto px-6 py-6 flex items-center justify-between text-xs text-muted-foreground">
          <span>© 2026 DualStats Tracker</span>
          <nav className="flex gap-4">
            <Link href="/terms"   className="hover:text-foreground transition-colors">Términos</Link>
            <Link href="/privacy" className="hover:text-foreground transition-colors">Privacidad</Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
