import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { prisma } from '@/lib/db/client'

// Deshabilitar el body-parser de Next.js para poder verificar la firma de Stripe
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig  = req.headers.get('stripe-signature')

  if (!sig) {
    return NextResponse.json({ error: 'No signature' }, { status: 400 })
  }

  // ── Verificar firma ───────────────────────────────────────────────────────
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err) {
    console.error('[webhook] Signature error:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // ── Procesar evento ───────────────────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session

    const { userId, plan, days } = session.metadata ?? {}

    if (!userId || !plan || !days) {
      console.error('[webhook] Missing metadata in session:', session.id)
      return NextResponse.json({ error: 'Missing metadata' }, { status: 400 })
    }

    const daysNum      = parseInt(days, 10)
    const planExpires  = new Date()
    planExpires.setDate(planExpires.getDate() + daysNum)

    try {
      await prisma.user.update({
        where: { id: userId },
        data: {
          plan:          plan as 'PRO' | 'PRO_TRACKER',
          planExpiresAt: planExpires,
          hasEverPaid:   true,
        },
      })
      console.log(`[webhook] ✅ Plan ${plan} activado para usuario ${userId} hasta ${planExpires.toISOString()}`)
    } catch (err) {
      console.error('[webhook] DB error:', err)
      return NextResponse.json({ error: 'DB update failed' }, { status: 500 })
    }
  }

  return NextResponse.json({ received: true })
}
