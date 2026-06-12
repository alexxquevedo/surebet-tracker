import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'

/**
 * GET /api/bot/subscription?telegram_id=123456
 *
 * El bot consulta si un usuario de Telegram tiene suscripción activa.
 * Combina dos fuentes:
 *   1. BotSubscription — usuarios que solo tienen el bot (sin cuenta web)
 *   2. User.plan — usuarios con cuenta web vinculada (PRO_TRACKER o ENTERPRISE)
 *
 * Respuesta:
 *   200 { subscribed, plan, expiresAt, daysLeft }
 */
export async function GET(request: NextRequest) {
  if (!verifyBotSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const telegramId = request.nextUrl.searchParams.get('telegram_id')
  if (!telegramId) {
    return NextResponse.json({ error: 'telegram_id requerido' }, { status: 400 })
  }

  const now = new Date()

  // ── 1. Buscar en BotSubscription (usuarios sin cuenta web) ───────────────
  const botSub = await prisma.botSubscription.findUnique({
    where: { telegramId },
  })

  if (botSub && botSub.expiresAt && botSub.expiresAt > now) {
    const daysLeft = Math.ceil((botSub.expiresAt.getTime() - now.getTime()) / 86400000)
    return NextResponse.json({
      subscribed: true,
      plan:       botSub.plan,
      expiresAt:  botSub.expiresAt.toISOString(),
      daysLeft,
      source:     'bot',
    })
  }

  // ── 2. Buscar cuenta web vinculada ───────────────────────────────────────
  const webUser = await prisma.user.findUnique({
    where:  { telegramId },
    select: { plan: true, planExpiresAt: true, isAdmin: true },
  })

  if (webUser) {
    // Admin siempre tiene acceso
    if (webUser.isAdmin) {
      return NextResponse.json({
        subscribed: true,
        plan:       'PRO_TRACKER',
        expiresAt:  null,
        daysLeft:   null,
        source:     'web_admin',
      })
    }

    // PRO_TRACKER con plan activo en la web
    if (
      (webUser.plan === 'PRO_TRACKER' || webUser.plan === 'ENTERPRISE') &&
      webUser.planExpiresAt &&
      webUser.planExpiresAt > now
    ) {
      const daysLeft = Math.ceil((webUser.planExpiresAt.getTime() - now.getTime()) / 86400000)
      return NextResponse.json({
        subscribed: true,
        plan:       'PRO_TRACKER',
        expiresAt:  webUser.planExpiresAt.toISOString(),
        daysLeft,
        source:     'web',
      })
    }
  }

  // ── Sin suscripción activa ───────────────────────────────────────────────
  return NextResponse.json({ subscribed: false, plan: 'FREE', expiresAt: null, daysLeft: null })
}
