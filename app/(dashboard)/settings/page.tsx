import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { SettingsClient } from './_components/settings-client'

export const metadata: Metadata = { title: 'Configuración — Surebet Tracker' }

export default async function SettingsPage() {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) redirect('/login')

  const [user, settingsRow, apiKeys] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where:  { id: userId },
      select: { name: true, email: true, plan: true, timezone: true, passwordHash: true },
    }),
    prisma.userSettings.findUnique({
      where:  { userId },
      select: { emailLoginAlert: true, emailOnSettle: true },
    }),
    prisma.apiKey.findMany({
      where:   { userId, isRevoked: false },
      select:  { id: true, name: true, keyPrefix: true, lastUsedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return (
    <SettingsClient
      user={{
        name:        user.name,
        email:       user.email,
        plan:        session.user.plan ?? 'FREE',
        timezone:    user.timezone,
        hasPassword: !!user.passwordHash,
      }}
      settings={{
        emailLoginAlert: settingsRow?.emailLoginAlert ?? true,
        emailOnSettle:   settingsRow?.emailOnSettle   ?? true,
      }}
      apiKeys={apiKeys.map((k) => ({
        id:         k.id,
        name:       k.name,
        keyPrefix:  k.keyPrefix,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        createdAt:  k.createdAt.toISOString(),
      }))}
    />
  )
}
