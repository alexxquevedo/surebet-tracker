import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { sendPlanExpiryEmail } from '@/lib/services/email'

/**
 * GET /api/cron/plan-expiry
 *
 * Envía un aviso por email a los usuarios cuyo plan expira en las próximas 24 horas.
 * Llamado diariamente por Vercel Cron (ver vercel.json).
 * Protegido por CRON_SECRET en el header Authorization.
 */
export async function GET(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now   = new Date()
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  const users = await prisma.user.findMany({
    where: {
      plan:         { not: 'FREE' },
      planExpiresAt: { gte: now, lte: in24h },
    },
    select: { id: true, email: true, name: true, plan: true, planExpiresAt: true },
  })

  let sent  = 0
  let errors = 0

  for (const user of users) {
    if (!user.email || !user.planExpiresAt) continue
    try {
      await sendPlanExpiryEmail(user.email, user.name, user.plan, user.planExpiresAt)
      sent++
    } catch (err) {
      console.error('[cron/plan-expiry] Error sending to', user.email, err)
      errors++
    }
  }

  console.log(`[cron/plan-expiry] Processed ${users.length} users — ${sent} sent, ${errors} errors`)
  return NextResponse.json({ ok: true, processed: users.length, sent, errors })
}
