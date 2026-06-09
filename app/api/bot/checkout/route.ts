import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'
import { stripe, PRICE_IDS, PLAN_CONFIG, FIRST_MONTH_COUPON, type PlanKey } from '@/lib/stripe'

/**
 * POST /api/bot/checkout
 *
 * El bot llama a este endpoint para obtener un link de pago de Stripe.
 * Body: { telegram_id: number, plan_key: string }
 *
 * - Si el telegram_id está vinculado a un usuario web, usa su email y hasEverPaid.
 * - Si no tiene cuenta web, crea la sesión sin email.
 * - Aplica descuento primer mes en bot_tracker si nunca ha pagado.
 */
export async function POST(request: NextRequest) {
  if (!verifyBotSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { telegram_id?: unknown; plan_key?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const telegramId = String(body.telegram_id ?? '')
  const planKey    = body.plan_key as PlanKey

  if (!telegramId || !planKey || !PRICE_IDS[planKey]) {
    return NextResponse.json({ error: 'telegram_id y plan_key requeridos' }, { status: 400 })
  }

  const config = PLAN_CONFIG[planKey]

  // ── Buscar si tiene cuenta web vinculada ──────────────────────────────────
  const webUser = await prisma.user.findUnique({
    where:  { telegramId },
    select: { email: true, hasEverPaid: true },
  })

  // ── Buscar si tiene BotSubscription previa ────────────────────────────────
  const botSub = await prisma.botSubscription.findUnique({
    where: { telegramId },
  })
  const hasEverPaid = webUser?.hasEverPaid ?? !!botSub

  // ── Descuento primer mes: solo en bot_tracker, primera compra ─────────────
  const applyDiscount = planKey === 'bot_tracker' && !hasEverPaid

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://dualstats-tracker.vercel.app'

  const checkoutSession = await stripe.checkout.sessions.create({
    mode:                 'payment',
    payment_method_types: ['card'],
    customer_email:       webUser?.email ?? undefined,
    line_items:           [{ price: PRICE_IDS[planKey], quantity: 1 }],
    ...(applyDiscount ? { discounts: [{ coupon: FIRST_MONTH_COUPON }] } : {}),
    metadata: {
      telegram_id: telegramId,
      planKey,
      plan:        config.plan,
      days:        String(config.days),
      source:      'bot',
    },
    success_url: `${appUrl}/bot-payment?success=1`,
    cancel_url:  `${appUrl}/bot-payment?canceled=1`,
    locale:      'es',
  })

  return NextResponse.json({ url: checkoutSession.url })
}
