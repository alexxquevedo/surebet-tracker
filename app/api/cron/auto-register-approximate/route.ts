import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'

/**
 * GET /api/cron/auto-register-approximate
 *
 * Converts stale TELEGRAM_BOT DRAFT bets (> 48h old) to PLACED + isApproximate = true.
 * Uses the original alert data already stored in the record — no user input needed.
 * Sends one Telegram notification per affected user.
 *
 * Called by Vercel Cron every 6 hours (see vercel.json).
 * Authenticated with CRON_SECRET header.
 */

const WEB_URL = 'https://dualstats-tracker.vercel.app'
const dsUrl = (path: string, campaign: string) =>
  `${WEB_URL}${path}?utm_source=fidesbot&utm_medium=bot&utm_campaign=${campaign}`

async function sendTelegramMessage(
  chatId: string,
  text: string,
  buttons?: Array<{ text: string; url: string }>,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return false

  const body: Record<string, unknown> = {
    chat_id:    chatId,
    text,
    parse_mode: 'Markdown',
  }
  if (buttons?.length) {
    body.reply_markup = {
      inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))],
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
      console.warn(`[cron/auto-register-approximate] Telegram error for ${chatId}:`, err)
      return false
    }
    return true
  } catch (e) {
    console.error(`[cron/auto-register-approximate] Fetch error for ${chatId}:`, e)
    return false
  }
}

export async function GET(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000)

  // Only auto-register bets created by the bot that have been stuck in DRAFT > 48h
  const staleDrafts = await prisma.betRecord.findMany({
    where: {
      status:     'DRAFT',
      createdVia: 'TELEGRAM_BOT',
      deletedAt:  null,
      datePlaced: { lte: cutoff },
    },
    select: {
      id:         true,
      type:       true,
      title:      true,
      totalStake: true,
      user:       { select: { id: true, telegramId: true } },
    },
  })

  if (staleDrafts.length === 0) {
    return NextResponse.json({ ok: true, converted: 0, notified: 0, errors: 0 })
  }

  // Bulk-convert all qualifying drafts
  const ids = staleDrafts.map((d) => d.id)
  await prisma.betRecord.updateMany({
    where: { id: { in: ids } },
    data:  { status: 'PLACED', isApproximate: true },
  })

  let notified = 0
  let errors   = 0

  // One Telegram message per user listing their converted bets
  const byUser = new Map<string, typeof staleDrafts>()
  for (const d of staleDrafts) {
    const uid = d.user.id
    if (!byUser.has(uid)) byUser.set(uid, [])
    byUser.get(uid)!.push(d)
  }

  for (const bets of byUser.values()) {
    const telegramId = bets[0]!.user.telegramId
    if (!telegramId) continue

    const lines = bets.map((b) => {
      const label = b.title
        ?? (b.type === 'ARBITRAGE' ? 'Surebet' : b.type === 'MIDDLE' ? 'Middlebet' : 'Apuesta')
      const stake = parseFloat(b.totalStake.toString()).toFixed(2)
      return `• ${label} — €${stake}`
    }).join('\n')

    const text =
      `📥 *Auto-registrado en DualStats*\n\n` +
      `Las siguientes apuestas se han registrado automáticamente con los datos originales _(pueden no ser exactos)_:\n\n` +
      `${lines}\n\n` +
      `⚠️ Marcadas como _Datos aproximados_. Puedes corregir los valores reales en cualquier momento desde la web.`

    const ok = await sendTelegramMessage(telegramId, text, [
      { text: '📊 Ver en DualStats', url: dsUrl('/records', 'auto_register') },
    ])
    if (ok) notified++
    else errors++
  }

  console.log(`[cron/auto-register-approximate] converted=${ids.length} notified=${notified} errors=${errors}`)
  return NextResponse.json({ ok: true, converted: ids.length, notified, errors })
}
