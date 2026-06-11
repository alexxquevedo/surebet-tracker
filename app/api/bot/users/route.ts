import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'

/**
 * GET /api/bot/users
 *
 * Carga bulk para el arranque del bot. Devuelve:
 *  - botSubscriptions: todos los registros activos en BotSubscription
 *    (expiresAt IS NULL o expiresAt > now) con config, credits, referrals
 *  - linkedUsers: usuarios web con telegramId vinculado (para dualstats_vinculados y dualstats_plan)
 */
export async function GET(request: NextRequest) {
  if (!verifyBotSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()

  const [botSubs, linkedUsers] = await Promise.all([
    prisma.botSubscription.findMany({
      where: {
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } },
        ],
      },
    }),
    prisma.user.findMany({
      where: { telegramId: { not: null } },
      select: { telegramId: true, plan: true, planExpiresAt: true, isAdmin: true },
    }),
  ])

  return NextResponse.json({
    botSubscriptions: botSubs.map((s) => ({
      telegramId:   s.telegramId,
      telegramName: s.telegramName,
      plan:         s.plan,
      expiresAt:    s.expiresAt?.toISOString() ?? null,
      config:       s.config,
      credits:      s.credits,
      referredUsers: s.referredUsers,
      referredBy:   s.referredBy,
    })),
    linkedUsers: linkedUsers
      .filter((u) => u.telegramId)
      .map((u) => ({
        telegramId: u.telegramId!,
        plan:       u.isAdmin ? 'PRO_TRACKER' : u.plan,
        expiresAt:  u.planExpiresAt?.toISOString() ?? null,
      })),
  })
}
