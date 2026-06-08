import { redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { SidebarNav } from './_components/sidebar-nav'
import { ThemeToggle } from '@/components/ui/theme-toggle'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) redirect('/login')

  // Fetch active bookmakers for the modal selector (exclude CLOSED and SUSPENDED)
  const bookmakers = await prisma.bookmaker.findMany({
    where:   { userId, status: { notIn: ['CLOSED', 'SUSPENDED'] } },
    select:  { id: true, name: true, color: true },
    orderBy: { name: 'asc' },
  })

  const plan      = session.user?.plan ?? 'FREE'
  const userName  = session.user?.name ?? null
  const userEmail = session.user?.email ?? null

  return (
    <div className="flex min-h-screen bg-background">
      {/* ── Sidebar (Client Component — usePathname + modal) ─────────── */}
      <SidebarNav
        bookmakers={bookmakers}
        plan={plan}
        userName={userName}
        userEmail={userEmail}
      />

      {/* ── Main content area ─────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Mobile topbar (hidden on md+) */}
        <header className="h-14 border-b flex items-center justify-between px-4 bg-card shrink-0 md:hidden">
          <span className="text-sm font-bold">Surebet Tracker</span>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
              {plan}
            </span>
          </div>
        </header>

        <div className="flex-1 p-6 pb-28 md:pb-6 overflow-auto">{children}</div>

        {/* ── Footer ────────────────────────────────────────────────────── */}
        <footer className="hidden md:flex shrink-0 border-t px-6 py-3 items-center justify-between text-xs text-muted-foreground bg-card">
          <span>© 2026 Surebet Tracker Pro</span>
          <nav className="flex gap-4">
            <Link href="/terms"   className="hover:text-foreground transition-colors">Términos de uso</Link>
            <Link href="/privacy" className="hover:text-foreground transition-colors">Privacidad</Link>
          </nav>
        </footer>
      </main>
    </div>
  )
}
