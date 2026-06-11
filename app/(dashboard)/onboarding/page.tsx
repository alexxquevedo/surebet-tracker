import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { OnboardingWizard } from './_components/onboarding-wizard'

export const metadata: Metadata = { title: 'Configuración inicial — DualStats Tracker' }

export default async function OnboardingPage() {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) redirect('/login')

  const [user, bookmakers] = await Promise.all([
    prisma.user.findUnique({
      where:  { id: userId },
      select: { telegramId: true },
    }),
    prisma.bookmaker.findMany({
      where:   { userId, status: 'ACTIVE' },
      select:  { id: true, name: true, etiqueta: true, initialCapital: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  if (!user) redirect('/login')

  const plan       = session.user?.plan ?? 'FREE'
  const step1Done  = bookmakers.length > 0
  const step2Done  = step1Done && bookmakers.every((b) => b.initialCapital !== null)
  const step3Done  = !!user.telegramId

  // Core steps done → go straight to dashboard (step 3 is optional)
  if (step1Done && step2Done) redirect('/dashboard')

  return (
    <OnboardingWizard
      step1Done={step1Done}
      step2Done={step2Done}
      step3Done={step3Done}
      bookmakers={bookmakers.map((b) => ({
        id:             b.id,
        name:           b.name,
        etiqueta:       b.etiqueta,
        initialCapital: b.initialCapital !== null ? parseFloat(b.initialCapital.toString()) : null,
      }))}
      plan={plan}
    />
  )
}
