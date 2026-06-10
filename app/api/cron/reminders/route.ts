import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'

/**
 * GET /api/cron/reminders
 *
 * Sends Telegram reminders for:
 *   1. PLACED bets without a result after 12h and 24h
 *   2. DRAFT bets (missing initial capital) after 12h
 *
 * Uses time windows to avoid duplicate messages:
 *   12h reminder: bet age 12–18h  (sent once per ~6h cron window)
 *   24h reminder: bet age 24–30h
 *   DRAFT 12h:    draft age 12–18h
 *
 * Called by Vercel Cron every 6 hours (see vercel.json).
 * Authenticated with CRON_SECRET header.
 */

const WEB_URL = 'https://dualstats-tracker.vercel.app'

async function sendTelegramMessage(
  chatId: string,
  text: string,
  inlineButtons?: Array<{ text: string; url?: string; callback_data?: string }>,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return false

  const body: Record<string, unknown> = {
    chat_id:    chatId,
    text,
    parse_mode: 'Markdown',
  }
  if (inlineButtons && inlineButtons.length > 0) {
    body.reply_markup = {
      inline_keyboard: [inlineButtons.map((b) => b.url
        ? { text: b.text, url: b.url }
        : { text: b.text, callback_data: b.callback_data ?? 'noop' })],
    }
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>
      console.warn(`[cron/reminders] Telegram error for chat ${chatId}:`, err)
      return false
    }
    return true
  } catch (e) {
    console.error(`[cron/reminders] Fetch error for chat ${chatId}:`, e)
    return false
  }
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60 * 1000)
}

export async function GET(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let placedReminders = 0
  let draftReminders  = 0
  let errors          = 0

  // ── 1. PLACED bets without result ──────────────────────────────────────────
  // Window A: 12–18h ago (12h reminder)
  // Window B: 24–30h ago (24h reminder)
  const placedBets = await prisma.betRecord.findMany({
    where: {
      status:    'PLACED',
      deletedAt: null,
      user: { telegramId: { not: null } },
      OR: [
        { datePlaced: { gte: hoursAgo(18), lte: hoursAgo(12) } },
        { datePlaced: { gte: hoursAgo(30), lte: hoursAgo(24) } },
      ],
    },
    select: {
      id:         true,
      title:      true,
      totalStake: true,
      datePlaced: true,
      user:       { select: { telegramId: true } },
    },
  })

  for (const bet of placedBets) {
    if (!bet.user.telegramId) continue
    const ageHours = (Date.now() - bet.datePlaced.getTime()) / (1000 * 60 * 60)
    const is24h    = ageHours >= 24

    const title = bet.title || 'Surebet / Middlebet'
    const text  = is24h
      ? `⏰ *Recordatorio (24h) — Resultado pendiente*\n\n📋 *${title}*\n\nHan pasado 24 horas y esta apuesta aún no tiene resultado registrado.\n\n¿Sabes ya el resultado? Actualízalo en DualStats 👇`
      : `⏰ *Recordatorio (12h) — Resultado pendiente*\n\n📋 *${title}*\n\nLlevas 12 horas con esta apuesta sin resultado.\n\nSi ya lo conoces, actualízalo en DualStats 👇`

    const ok = await sendTelegramMessage(
      bet.user.telegramId,
      text,
      [
        { text: '🏆 Registrar resultado', url: `${WEB_URL}/records` },
      ],
    )
    if (ok) placedReminders++
    else errors++
  }

  // ── 2. DRAFT bets (12–18h without confirmation) ────────────────────────────
  const draftBets = await prisma.betRecord.findMany({
    where: {
      status:    'DRAFT',
      deletedAt: null,
      user:      { telegramId: { not: null } },
      createdAt: { gte: hoursAgo(18), lte: hoursAgo(12) },
    },
    select: {
      id:    true,
      title: true,
      user:  { select: { telegramId: true } },
      legs: {
        select: {
          bookmaker: { select: { name: true, etiqueta: true, initialCapital: true } },
        },
      },
    },
  })

  for (const draft of draftBets) {
    if (!draft.user.telegramId) continue

    const missing = draft.legs
      .filter((l) => l.bookmaker.initialCapital === null)
      .map((l) => l.bookmaker.etiqueta
        ? `${l.bookmaker.name} · ${l.bookmaker.etiqueta}`
        : l.bookmaker.name)
      .filter((n, i, a) => a.indexOf(n) === i)

    const title      = draft.title || 'Apuesta'
    const missingTxt = missing.length > 0
      ? `\n\nCasas sin capital: *${missing.join(', ')}*`
      : ''

    const ok = await sendTelegramMessage(
      draft.user.telegramId,
      `⚠️ *Apuesta en Borrador — Sin confirmar (12h)*\n\n📋 *${title}*${missingTxt}\n\nRegistra el capital inicial en *Casas de Apuestas* y confirma la apuesta para que se procese correctamente.`,
      [
        { text: '🏦 Ir a Casas de Apuestas', url: `${WEB_URL}/bookmakers` },
        { text: '📋 Ver Pendientes',          url: `${WEB_URL}/records` },
      ],
    )
    if (ok) draftReminders++
    else errors++
  }

  console.log(`[cron/reminders] placed=${placedReminders} drafts=${draftReminders} errors=${errors}`)
  return NextResponse.json({
    ok: true,
    placedReminders,
    draftReminders,
    errors,
  })
}
