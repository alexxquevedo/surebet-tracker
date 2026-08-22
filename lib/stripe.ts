import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-05-27.dahlia',
})

// ── Price IDs (live) ─────────────────────────────────────────────────────────
//
// Planes WEB (vendidos en dualstats-tracker.vercel.app):
//   tracker_web  → DualStats Tracker solo (sin bot)  —  9,99 €
//   tracker_30   → PRO+Tracker bundle (bot + web)     — 49,99 €
//
// Planes BOT (vendidos solo en FidesBot, sin cuenta web necesaria):
//   bot_7        → FidesBot PRO · 1 semana            — 19,99 €
//   bot_14       → FidesBot PRO · 2 semanas           — 32,99 €
//   bot_30       → FidesBot PRO · 1 mes               — 44,99 €
//   bot_tracker  → FidesBot PRO+Tracker · 1 mes       — 49,99 €
export const PRICE_IDS = {
  // Web
  tracker_web:  'price_1U6vTvQ4XBiTLOZfNxTQhxly', //  9,99 € · DualStats Tracker solo
  tracker_30:   'price_1U6vTwQ4XBiTLOZfFY3bwNq8', // 49,99 € · PRO+Tracker (bot + web)
  // Bot
  bot_7:        'price_1U6vTwQ4XBiTLOZfPRulwYuB', // 19,99 € · PRO 1 semana
  bot_14:       'price_1U6vTvQ4XBiTLOZf4DtpNDsZ', // 32,99 € · PRO 2 semanas
  bot_30:       'price_1U6vTyQ4XBiTLOZfW8MIB6eq', // 44,99 € · PRO 1 mes
  bot_tracker:  'price_1U6vTwQ4XBiTLOZfFY3bwNq8', // 49,99 € · PRO+Tracker 1 mes
} as const

export type PlanKey = keyof typeof PRICE_IDS

export const PLAN_CONFIG: Record<
  PlanKey,
  { plan: 'PRO' | 'PRO_TRACKER'; days: number; label: string; amount: number; isBot: boolean }
> = {
  tracker_web: { plan: 'PRO',         days: 30, label: 'DualStats Tracker · 1 mes',     amount:  999, isBot: false },
  tracker_30:  { plan: 'PRO_TRACKER', days: 30, label: 'DualStats PRO+Tracker · 1 mes', amount: 4999, isBot: false },
  bot_7:       { plan: 'PRO',         days: 7,  label: 'FidesBot PRO · 1 semana',        amount: 1999, isBot: true  },
  bot_14:      { plan: 'PRO',         days: 14, label: 'FidesBot PRO · 2 semanas',       amount: 3299, isBot: true  },
  bot_30:      { plan: 'PRO',         days: 30, label: 'FidesBot PRO · 1 mes',           amount: 4499, isBot: true  },
  bot_tracker: { plan: 'PRO_TRACKER', days: 30, label: 'FidesBot PRO+Tracker · 1 mes',  amount: 4999, isBot: true  },
}

// Precios de primer mes — solo para usuarios que nunca han pagado, solo en planes mensuales
export const FIRST_MONTH_PRICE_IDS: Partial<Record<PlanKey, string>> = {
  bot_30:      'price_1U72fgQ4XBiTLOZfxERttz6C', // 34,99 € · PRO 1 mes (primer mes)
  bot_tracker: 'price_1U72bsQ4XBiTLOZfu5iciQNB', // 39,99 € · PRO+Tracker 1 mes (primer mes)
  tracker_30:  'price_1U72bsQ4XBiTLOZfu5iciQNB', // 39,99 € · PRO+Tracker web (primer mes)
}
