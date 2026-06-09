'use server'

import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { randomBytes } from 'crypto'
import { revalidatePath } from 'next/cache'

export type TelegramActionResult =
  | { success: true; message?: string }
  | { success: false; error: string }

export type GenerateLinkResult =
  | { success: true; deepLink: string; manualToken: string; expiresAt: string }
  | { success: false; error: string }

const TOKEN_TTL_MS = 10 * 60 * 1000 // 10 minutos

/**
 * Genera un token de vinculación de un solo uso.
 * Devuelve el deep link de Telegram y el token manual (/start CONNECT_xxx).
 *
 * Solo disponible para usuarios con plan PRO.
 */
export async function generateLinkTokenAction(): Promise<GenerateLinkResult> {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  // Solo PRO puede vincular
  const userPlan = (session?.user as { plan?: string })?.plan ?? 'FREE'
  if (userPlan === 'FREE') {
    return { success: false, error: 'Necesitas el plan PRO para vincular FidesBot.' }
  }

  // Invalidar tokens anteriores no usados (higiene)
  await prisma.linkToken.deleteMany({
    where: { userId, usedAt: null },
  })

  const token     = randomBytes(32).toString('hex') // 64 chars hex
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)

  await prisma.linkToken.create({
    data: { userId, token, expiresAt },
  })

  const botName  = process.env.TELEGRAM_BOT_NAME ?? 'FidesBot'
  const deepLink = `https://t.me/${botName}?start=CONNECT_${token}`

  return {
    success:      true,
    deepLink,
    manualToken:  `CONNECT_${token}`,
    expiresAt:    expiresAt.toISOString(),
  }
}

/**
 * Desvincula la cuenta de Telegram del usuario actual.
 */
export async function unlinkTelegramAction(): Promise<TelegramActionResult> {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data:  { telegramId: null, telegramUsername: null },
    }),
    prisma.userIntegration.updateMany({
      where: { userId, type: 'TELEGRAM' },
      data:  { status: 'REVOKED', lastError: 'Desvinculado por el usuario' },
    }),
    // Limpiar tokens pendientes
    prisma.linkToken.deleteMany({
      where: { userId, usedAt: null },
    }),
  ])

  revalidatePath('/settings')
  return { success: true, message: 'Cuenta de FidesBot desvinculada correctamente.' }
}
