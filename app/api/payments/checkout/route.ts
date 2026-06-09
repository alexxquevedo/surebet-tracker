import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { stripe, PRICE_IDS, PLAN_CONFIG, FIRST_MONTH_COUPON, type PlanKey } from '@/lib/stripe'

export async function POST(req: NextRequest) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 })
  }

  // ── Body ─────────────────────────────────────────────────────────────────
  let body: { planKey?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const planKey = body.planKey as PlanKey
  if (!planKey || !PRICE_IDS[planKey]) {
    return NextResponse.json({ error: 'Plan inválido' }, { status: 400 })
  }

  // ── Usuario ───────────────────────────────────────────────────────────────
  const user = await prisma.user.findUnique({
    where:  { id: session.user.id },
    select: { id: true, email: true, hasEverPaid: true },
  })
  if (!user) {
    return NextResponse.json({ error: 'Usuario no encontrado' }, { status: 404 })
  }

  const config = PLAN_CONFIG[planKey]

  // ── Descuento primer mes (planes mensuales, solo primera compra del usuario) ─
  const isMonthly     = planKey === 'pro_30' || planKey === 'tracker_30'
  const applyDiscount = isMonthly && !user.hasEverPaid

  // ── Crear sesión de Checkout ──────────────────────────────────────────────
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  const checkoutSession = await stripe.checkout.sessions.create({
    mode:                 'payment',
    payment_method_types: ['card'],
    customer_email:       user.email ?? undefined,
    line_items: [{ price: PRICE_IDS[planKey], quantity: 1 }],
    ...(applyDiscount ? { discounts: [{ coupon: FIRST_MONTH_COUPON }] } : {}),
    metadata: {
      userId:  user.id,
      planKey,
      plan:    config.plan,
      days:    String(config.days),
    },
    success_url: `${appUrl}/settings?tab=suscripcion&success=1`,
    cancel_url:  `${appUrl}/settings?tab=suscripcion&canceled=1`,
    locale: 'es',
  })

  return NextResponse.json({ url: checkoutSession.url })
}
