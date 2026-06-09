import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { SettingsClient } from './_components/settings-client'
import { getAdminDataAction } from '@/lib/actions/admin'

export const metadata: Metadata = { title: 'Configuración — DualStats Tracker' }

export default async function SettingsPage() {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) redirect('/login')

  const [user, settingsRow, apiKeys] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where:  { id: userId },
      select: {
        name: true, email: true, plan: true, timezone: true, currency: true, passwordHash: true,
        telegramId: true, telegramUsername: true, isAdmin: true,
      },
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

  // Si es admin, cargar datos del panel
  const adminData = user.isAdmin ? await getAdminDataAction() : null

  return (
    <SettingsClient
      user={{
        name:        user.name,
        email:       user.email,
        plan:        session.user.plan ?? 'FREE',
        timezone:    user.timezone,
        currency:    user.currency,
        hasPassword: !!user.passwordHash,
        isAdmin:     user.isAdmin,
      }}
      settings={{
        emailLoginAlert: settingsRow?.emailLoginAlert ?? true,
        emailOnSettle:   settingsRow?.emailOnSettle   ?? true,
      }}
      telegram={{
        connected: !!user.telegramId,
        username:  user.telegramUsername ?? null,
      }}
      admin={adminData?.success ? { stats: adminData.stats, users: adminData.users } : null}
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
