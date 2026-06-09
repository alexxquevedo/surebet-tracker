import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-05-27.dahlia',
})

// ── Price IDs (test) ─────────────────────────────────────────────────────────
//
// Planes WEB (vendidos en dualstats-tracker.vercel.app):
//   tracker_web  → DualStats Tracker solo (sin bot)  — 9,99 €
//   tracker_30   → PRO+Tracker bundle (bot + web)     — 49,99 €
//
// Planes BOT (vendidos solo en FidesBot, sin cuenta web necesaria):
//   bot_7        → FidesBot PRO · 1 semana            — 17 €
//   bot_14       → FidesBot PRO · 2 semanas           — 25 €
//   bot_30       → FidesBot PRO · 1 mes               — 45 €
//   bot_tracker  → FidesBot PRO+Tracker · 1 mes       — 49,99 €
export const PRICE_IDS = {
  // Web
  tracker_web:  'price_1TgTywLJ1CtJdyu0UwLUw9U6', //  9,99 € · DualStats Tracker solo
  tracker_30:   'price_1TgSj9LJ1CtJdyu0UndC5qpX', // 49,99 € · PRO+Tracker (bot + web)
  // Bot
  bot_7:        'price_1TgShdLJ1CtJdyu0sfDnqgJS', // 17 €    · PRO 1 semana
  bot_14:       'price_1TgSiALJ1CtJdyu0nrC3KZZt', // 25 €    · PRO 2 semanas
  bot_30:       'price_1TgSfdLJ1CtJdyu0Dp3qEobF', // 45 €    · PRO 1 mes
  bot_tracker:  'price_1TgSj9LJ1CtJdyu0UndC5qpX', // 49,99 € · PRO+Tracker (mismo producto)
} as const

export type PlanKey = keyof typeof PRICE_IDS

export const PLAN_CONFIG: Record<
  PlanKey,
  { plan: 'PRO' | 'PRO_TRACKER'; days: number; label: string; amount: number; isBot: boolean }
> = {
  tracker_web: { plan: 'PRO',         days: 30, label: 'DualStats Tracker · 1 mes',        amount: 999,  isBot: false },
  tracker_30:  { plan: 'PRO_TRACKER', days: 30, label: 'DualStats PRO+Tracker · 1 mes',    amount: 4999, isBot: false },
  bot_7:       { plan: 'PRO',         days: 7,  label: 'FidesBot PRO · 1 semana',           amount: 1700, isBot: true  },
  bot_14:      { plan: 'PRO',         days: 14, label: 'FidesBot PRO · 2 semanas',          amount: 2500, isBot: true  },
  bot_30:      { plan: 'PRO',         days: 30, label: 'FidesBot PRO · 1 mes',              amount: 4500, isBot: true  },
  bot_tracker: { plan: 'PRO_TRACKER', days: 30, label: 'FidesBot PRO+Tracker · 1 mes',     amount: 4999, isBot: true  },
}

// Cupón de bienvenida: 10 € de descuento — solo primera compra, solo en planes mensuales con tracker
export const FIRST_MONTH_COUPON = 'PRIMER_MES'
