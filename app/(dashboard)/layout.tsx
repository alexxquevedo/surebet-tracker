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
  const [bookmakers, bankrolls, betComps, comboComps] = await Promise.all([
    prisma.bookmaker.findMany({
      where:   { userId, status: { notIn: ['CLOSED', 'SUSPENDED'] } },
      select:  { id: true, name: true, color: true },
      orderBy: { name: 'asc' },
    }),
    prisma.bankroll.findMany({
      where:   { userId, isActive: true },
      select:  { id: true, name: true, color: true },
      orderBy: { name: 'asc' },
    }),
    prisma.betRecord.findMany({
      where:   { userId, deletedAt: null, competition: { not: null } },
      select:  { competition: true },
      distinct: ['competition'],
    }),
    prisma.comboSelection.findMany({
      where:   { competition: { not: null }, comboDetail: { betRecord: { userId, deletedAt: null } } },
      select:  { competition: true },
      distinct: ['competition'],
    }),
  ])

  const usedCompetitions = [...new Set([
    ...betComps.map((r) => r.competition as string),
    ...comboComps.map((r) => r.competition as string),
  ])].filter(Boolean).sort()

  const plan      = session.user?.plan ?? 'FREE'
  const userName  = session.user?.name ?? null
  const userEmail = session.user?.email ?? null

  // Fetch isAdmin for sidebar
  const userId2   = session.user?.id
  const dbUser    = userId2
    ? await prisma.user.findUnique({ where: { id: userId2 }, select: { isAdmin: true } })
    : null
  const isAdmin   = dbUser?.isAdmin ?? false

  return (
    <div className="flex min-h-screen bg-background">
      {/* ── Sidebar (Client Component — usePathname + modal) ─────────── */}
      <SidebarNav
        bookmakers={bookmakers}
        bankrolls={bankrolls}
        plan={plan}
        userName={userName}
        userEmail={userEmail}
        isAdmin={isAdmin}
        usedCompetitions={usedCompetitions}
      />

      {/* ── Main content area ─────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Mobile topbar (hidden on md+) */}
        <header className="h-14 border-b flex items-center justify-between px-4 bg-card shrink-0 md:hidden">
          <span className="text-sm font-bold">DualStats Tracker</span>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
              {plan}
            </span>
          </div>
        </header>

        <div className="flex-1 p-6 pb-28 md:pb-6 overflow-auto">{children}</div>

        {/* ── Footer ────────────────────────────────────────────────────── */}
        <footer className="flex shrink-0 border-t px-4 py-3 items-center justify-between text-xs text-muted-foreground bg-card mb-16 md:mb-0">
          <span>© 2026 DualStats Tracker</span>
          <nav className="flex gap-4">
            <Link href="/terms"   className="hover:text-foreground transition-colors">Términos de uso</Link>
            <Link href="/privacy" className="hover:text-foreground transition-colors">Privacidad</Link>
          </nav>
        </footer>
      </main>
    </div>
  )
}
