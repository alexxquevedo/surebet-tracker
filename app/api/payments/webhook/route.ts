import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { prisma } from '@/lib/db/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Enviar mensaje de confirmación por Telegram ───────────────────────────────
async function notificarTelegram(telegramId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: telegramId, text, parse_mode: 'Markdown' }),
    })
  } catch (err) {
    console.error('[webhook] Error enviando notificación Telegram:', err)
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig  = req.headers.get('stripe-signature')

  if (!sig) return NextResponse.json({ error: 'No signature' }, { status: 400 })

  // ── Verificar firma ───────────────────────────────────────────────────────
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err) {
    console.error('[webhook] Signature error:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // ── Procesar pago completado ──────────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    const { userId, telegram_id, plan, days, source } = session.metadata ?? {}

    if (!plan || !days) {
      console.error('[webhook] Missing metadata:', session.id)
      return NextResponse.json({ error: 'Missing metadata' }, { status: 400 })
    }

    const validPlans = ['PRO', 'PRO_TRACKER'] as const
    if (!(validPlans as readonly string[]).includes(plan)) {
      console.error('[webhook] Invalid plan in metadata:', plan, session.id)
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
    }

    const daysNum = parseInt(days, 10)
    if (isNaN(daysNum) || daysNum <= 0) {
      console.error('[webhook] Invalid days in metadata:', days, session.id)
      return NextResponse.json({ error: 'Invalid days' }, { status: 400 })
    }

    const now = new Date()

    // ── PAGO DESDE LA WEB (tiene userId) ─────────────────────────────────
    if (source !== 'bot' && userId) {
      // Fetch current state before updating — needed for expiry extension + telegramId
      const currentUser = await prisma.user.findUnique({
        where:  { id: userId },
        select: { planExpiresAt: true, telegramId: true },
      })
      // Extend from current expiry if still active (avoids losing remaining days on renewal)
      const base       = currentUser?.planExpiresAt && currentUser.planExpiresAt > now ? currentUser.planExpiresAt : now
      const planExpires = new Date(base.getTime() + daysNum * 24 * 60 * 60 * 1000)

      await prisma.user.update({
        where: { id: userId },
        data:  { plan: plan as 'PRO' | 'PRO_TRACKER', planExpiresAt: planExpires, hasEverPaid: true },
      })

      if (currentUser?.telegramId && plan === 'PRO_TRACKER') {
        await prisma.botSubscription.upsert({
          where:  { telegramId: currentUser.telegramId },
          create: { telegramId: currentUser.telegramId, plan: 'PRO_TRACKER', expiresAt: planExpires },
          update: { plan: 'PRO_TRACKER', expiresAt: planExpires },
        })
        await notificarTelegram(
          currentUser.telegramId,
          `✅ *¡Tu plan PRO+Tracker está activo!*\n\nTu pago desde la web se ha procesado correctamente.\nTienes acceso por *${daysNum} días* 🚀\n\nUsa /start para ver tus opciones.`,
        )
      }
      console.log(`[webhook] ✅ Web: plan ${plan} activado para usuario ${userId}`)
    }

    // ── PAGO DESDE EL BOT (tiene telegram_id) ────────────────────────────
    if (source === 'bot' && telegram_id) {
      // Fetch current BotSubscription to extend expiry rather than reset it
      const [currentSub, webUser] = await Promise.all([
        prisma.botSubscription.findUnique({
          where:  { telegramId: telegram_id },
          select: { expiresAt: true },
        }),
        prisma.user.findUnique({
          where:  { telegramId: telegram_id },
          select: { id: true, planExpiresAt: true },
        }),
      ])

      const subBase    = currentSub?.expiresAt && currentSub.expiresAt > now ? currentSub.expiresAt : now
      const planExpires = new Date(subBase.getTime() + daysNum * 24 * 60 * 60 * 1000)

      await prisma.botSubscription.upsert({
        where:  { telegramId: telegram_id },
        create: { telegramId: telegram_id, plan, expiresAt: planExpires },
        update: { plan, expiresAt: planExpires },
      })

      if (webUser) {
        // For PRO_TRACKER also extend the web plan from its own current expiry
        let webExpires = planExpires
        if (plan === 'PRO_TRACKER' && webUser.planExpiresAt && webUser.planExpiresAt > now) {
          webExpires = new Date(webUser.planExpiresAt.getTime() + daysNum * 24 * 60 * 60 * 1000)
        }
        await prisma.user.update({
          where: { id: webUser.id },
          data: {
            hasEverPaid: true,
            ...(plan === 'PRO_TRACKER' ? { plan: 'PRO_TRACKER', planExpiresAt: webExpires } : {}),
          },
        })
      }

      const planLabel = plan === 'PRO_TRACKER' ? 'PRO+Tracker' : 'PRO'
      await notificarTelegram(
        telegram_id,
        `✅ *¡Pago recibido! Tu plan ${planLabel} está activo.*\n\nTienes acceso por *${daysNum} días* 🚀\n\nUsa /start para ver tus opciones.`,
      )
      console.log(`[webhook] ✅ Bot: plan ${plan} activado para telegram ${telegram_id}`)
    }
  }

  return NextResponse.json({ received: true })
}
