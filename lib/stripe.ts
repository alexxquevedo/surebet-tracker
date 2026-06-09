import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-05-27.dahlia',
})

// ── Price IDs (test) ─────────────────────────────────────────────────────────
// tracker_web  → DualStats Tracker solo (sin bot)     — 9,99 €
// tracker_30   → PRO+Tracker bundle (bot + web)        — 49,99 €
//
// Los planes del bot (1 sem, 2 sem, PRO 1 mes) se venden solo en el bot
// mediante transferencia bancaria y NO pasan por Stripe.
export const PRICE_IDS = {
  tracker_web: 'price_1TgTywLJ1CtJdyu0UwLUw9U6', //  9,99 € · DualStats Tracker solo
  tracker_30:  'price_1TgSj9LJ1CtJdyu0UndC5qpX', // 49,99 € · PRO+Tracker (bot + web)
} as const

export type PlanKey = keyof typeof PRICE_IDS

export const PLAN_CONFIG: Record<
  PlanKey,
  { plan: 'PRO' | 'PRO_TRACKER'; days: number; label: string; amount: number }
> = {
  tracker_web: { plan: 'PRO',         days: 30, label: 'DualStats Tracker · 1 mes',      amount: 999  },
  tracker_30:  { plan: 'PRO_TRACKER', days: 30, label: 'DualStats PRO+Tracker · 1 mes',  amount: 4999 },
}

// Cupón de bienvenida: 10 € de descuento — solo primera compra, solo en tracker_30
export const FIRST_MONTH_COUPON = 'PRIMER_MES'
