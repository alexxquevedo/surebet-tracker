import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'

/**
 * GET /api/bot/user/:telegramId
 *
 * El bot llama a este endpoint para verificar si un telegram_id
 * está vinculado a una cuenta DualStats y si tiene plan PRO activo.
 *
 * Usado al arrancar el bot (sync inicial) y opcionalmente en cada operación.
 *
 * Respuestas:
 *   200 { linked: false }                         — no vinculado
 *   200 { linked: true, isPro: bool, username? }  — vinculado
 *   401 Secreto inválido
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ telegramId: string }> },
) {
  if (!verifyBotSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { telegramId } = await params

  const user = await prisma.user.findUnique({
    where:  { telegramId },
    select: { id: true, plan: true, planExpiresAt: true, telegramUsername: true },
  })

  if (!user) {
    return NextResponse.json({ linked: false })
  }

  const hasActivePro =
    (user.plan === 'PRO' || user.plan === 'PRO_TRACKER' || user.plan === 'ENTERPRISE') &&
    (!user.planExpiresAt || user.planExpiresAt > new Date())

  return NextResponse.json({
    linked:   true,
    userId:   user.id,
    isPro:    hasActivePro,
    plan:     user.plan,
    username: user.telegramUsername,
  })
}
