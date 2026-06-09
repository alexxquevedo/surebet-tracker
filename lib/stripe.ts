import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-05-27.dahlia',
})

// ── Price IDs (test) ─────────────────────────────────────────────────────────
export const PRICE_IDS = {
  pro_7:      'price_1TgShdLJ1CtJdyu0sfDnqgJS', // 17 € · 1 semana
  pro_14:     'price_1TgSiALJ1CtJdyu0nrC3KZZt', // 25 € · 2 semanas
  pro_30:     'price_1TgSfdLJ1CtJdyu0Dp3qEobF', // 45 € · 1 mes
  tracker_30: 'price_1TgSj9LJ1CtJdyu0UndC5qpX', // 49 € · PRO+Tracker 1 mes
} as const

export type PlanKey = keyof typeof PRICE_IDS

export const PLAN_CONFIG: Record<
  PlanKey,
  { plan: 'PRO' | 'PRO_TRACKER'; days: number; label: string; amount: number }
> = {
  pro_7:      { plan: 'PRO',         days: 7,  label: 'FidesBot PRO · 1 semana',      amount: 1700 },
  pro_14:     { plan: 'PRO',         days: 14, label: 'FidesBot PRO · 2 semanas',     amount: 2500 },
  pro_30:     { plan: 'PRO',         days: 30, label: 'FidesBot PRO · 1 mes',         amount: 4500 },
  tracker_30: { plan: 'PRO_TRACKER', days: 30, label: 'FidesBot PRO+Tracker · 1 mes', amount: 4999 },
}

// Cupón de bienvenida: 16 € de descuento → el usuario paga 29 € (solo primer pago, plan mensual)
export const FIRST_MONTH_COUPON = 'PRIMER_MES'
