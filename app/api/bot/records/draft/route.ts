import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'

/**
 * GET /api/bot/records/draft?telegram_id=<number>
 *
 * Returns DRAFT BetRecords for the user — bets registered (via web or bot)
 * that are stuck in DRAFT because one or more bookmakers lack initialCapital.
 * Used by the bot to display these inside /pendientes so the user knows
 * they need to fix the capital setup on the web.
 */
export async function GET(request: NextRequest) {
  if (!verifyBotSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const telegramId = request.nextUrl.searchParams.get('telegram_id')
  if (!telegramId) {
    return NextResponse.json({ error: 'telegram_id required' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where:  { telegramId },
    select: { id: true },
  })
  if (!user) {
    return NextResponse.json({ error: 'USER_NOT_LINKED' }, { status: 404 })
  }

  const records = await prisma.betRecord.findMany({
    where:   { userId: user.id, status: 'DRAFT', deletedAt: null },
    orderBy: { datePlaced: 'desc' },
    take:    30,
    select: {
      id:         true,
      type:       true,
      title:      true,
      sport:      true,
      totalStake: true,
      datePlaced: true,
      // ARB / MIDDLE legs
      legs: {
        select: {
          bookmaker: { select: { name: true, etiqueta: true, initialCapital: true } },
        },
      },
      // SINGLE / COMBO / CASINO / CUSTOM
      primaryBookmaker: {
        select: { name: true, etiqueta: true, initialCapital: true },
      },
    },
  })

  return NextResponse.json({
    success: true,
    drafts: records.map((r) => {
      // Collect all bookmakers involved in this bet
      const bms = r.legs.length > 0
        ? r.legs.map((l) => l.bookmaker)
        : r.primaryBookmaker ? [r.primaryBookmaker] : []

      const missingCapital = bms
        .filter((b) => b.initialCapital === null)
        .map((b) => b.etiqueta ? `${b.name} · ${b.etiqueta}` : b.name)

      return {
        id:             r.id,
        type:           r.type,
        title:          r.title,
        sport:          r.sport,
        totalStake:     parseFloat(r.totalStake.toString()),
        datePlaced:     r.datePlaced.toISOString(),
        missingCapital,
      }
    }),
  })
}
