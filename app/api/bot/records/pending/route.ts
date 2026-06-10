import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'

/**
 * GET /api/bot/records/pending?telegram_id=<number>
 *
 * Returns PLACED BetRecords that came from the bot (have botPendingId set)
 * and don't have a final result yet. Used by the bot to sync /resultados.
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
    where: {
      userId:        user.id,
      status:        'PLACED',
      botPendingId:  { not: null },
      deletedAt:     null,
    },
    orderBy: { datePlaced: 'desc' },
    take: 50,
    select: {
      id:           true,
      botPendingId: true,
      type:         true,
      title:        true,
      sport:        true,
      totalStake:   true,
      datePlaced:   true,
      legs: {
        select: {
          bookmaker: { select: { name: true, etiqueta: true } },
          stake:     true,
          odds:      true,
        },
      },
    },
  })

  return NextResponse.json({
    success: true,
    records: records.map((r) => ({
      id:           r.id,
      botPendingId: r.botPendingId,
      type:         r.type,
      title:        r.title,
      sport:        r.sport,
      totalStake:   parseFloat(r.totalStake.toString()),
      datePlaced:   r.datePlaced.toISOString(),
      legs:         r.legs.map((l) => ({
        bookmaker: l.bookmaker.etiqueta
          ? `${l.bookmaker.name} · ${l.bookmaker.etiqueta}`
          : l.bookmaker.name,
        stake:     parseFloat(l.stake.toString()),
        odds:      parseFloat(l.odds.toString()),
      })),
    })),
  })
}
