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

    const daysNum     = parseInt(days, 10)
    const planExpires = new Date()
    planExpires.setDate(planExpires.getDate() + daysNum)

    // ── PAGO DESDE LA WEB (tiene userId) ─────────────────────────────────
    if (source !== 'bot' && userId) {
      await prisma.user.update({
        where: { id: userId },
        data:  { plan: plan as 'PRO' | 'PRO_TRACKER', planExpiresAt: planExpires, hasEverPaid: true },
      })

      // Si tiene Telegram vinculado y plan = PRO_TRACKER → activar también BotSubscription
      const user = await prisma.user.findUnique({
        where:  { id: userId },
        select: { telegramId: true },
      })
      if (user?.telegramId && plan === 'PRO_TRACKER') {
        await prisma.botSubscription.upsert({
          where:  { telegramId: user.telegramId },
          create: { telegramId: user.telegramId, plan: 'PRO_TRACKER', expiresAt: planExpires },
          update: { plan: 'PRO_TRACKER', expiresAt: planExpires },
        })
        await notificarTelegram(
          user.telegramId,
          `✅ *¡Tu plan PRO+Tracker está activo!*\n\nTu pago desde la web se ha procesado correctamente.\nTienes acceso por *${daysNum} días* 🚀\n\nUsa /start para ver tus opciones.`,
        )
      }
      console.log(`[webhook] ✅ Web: plan ${plan} activado para usuario ${userId}`)
    }

    // ── PAGO DESDE EL BOT (tiene telegram_id) ────────────────────────────
    if (source === 'bot' && telegram_id) {
      // Activar BotSubscription
      await prisma.botSubscription.upsert({
        where:  { telegramId: telegram_id },
        create: { telegramId: telegram_id, plan, expiresAt: planExpires },
        update: { plan, expiresAt: planExpires },
      })

      // Si tiene cuenta web vinculada y plan = PRO_TRACKER → sincronizar web
      if (plan === 'PRO_TRACKER') {
        const webUser = await prisma.user.findUnique({
          where:  { telegramId: telegram_id },
          select: { id: true },
        })
        if (webUser) {
          await prisma.user.update({
            where: { id: webUser.id },
            data:  { plan: 'PRO_TRACKER', planExpiresAt: planExpires, hasEverPaid: true },
          })
        }
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
