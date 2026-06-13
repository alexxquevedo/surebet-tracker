import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'

/**
 * GET /api/bot/stats?telegram_id=XXX&period=all|week|month
 *
 * Devuelve un resumen de estadísticas para el usuario vinculado al telegram_id.
 * Usado por /resumen y el digest semanal del bot.
 */
export async function GET(request: NextRequest) {
  if (!verifyBotSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sp         = request.nextUrl.searchParams
  const telegramId = sp.get('telegram_id')
  const period     = sp.get('period') ?? 'all'

  if (!telegramId) {
    return NextResponse.json({ error: 'telegram_id requerido' }, { status: 400 })
  }

  const user = await prisma.user.findFirst({
    where:  { telegramId },
    select: { id: true },
  })

  if (!user) {
    return NextResponse.json({ error: 'Usuario no vinculado' }, { status: 404 })
  }

  const now = new Date()
  let dateFrom: Date | undefined
  if      (period === 'week')  dateFrom = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000)
  else if (period === 'month') dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const dateFilter = dateFrom ? { datePlaced: { gte: dateFrom } } : {}
  const userId     = user.id

  const [settled, openCount, recentSettled] = await Promise.all([
    prisma.betRecord.findMany({
      where:  { userId, deletedAt: null, status: { in: ['WON', 'LOST', 'CASHOUT', 'VOID'] }, ...dateFilter },
      select: { status: true, grossProfit: true, totalStake: true },
    }),
    prisma.betRecord.count({
      where: { userId, deletedAt: null, status: 'PLACED' },
    }),
    // Racha actual siempre sobre el historial completo (sin filtro de período)
    prisma.betRecord.findMany({
      where:   { userId, deletedAt: null, status: { in: ['WON', 'LOST', 'CASHOUT'] } },
      select:  { status: true },
      orderBy: { datePlaced: 'desc' },
      take: 30,
    }),
  ])

  const won     = settled.filter((r) => r.status === 'WON').length
  const nonVoid = settled.filter((r) => r.status !== 'VOID')
  const winRate = nonVoid.length > 0 ? (won / nonVoid.length) * 100 : 0

  const totalProfit = settled.reduce((acc, r) => acc + (r.grossProfit ? parseFloat(r.grossProfit.toString()) : 0), 0)
  const totalStake  = settled.reduce((acc, r) => acc + parseFloat(r.totalStake.toString()), 0)
  const roi         = totalStake > 0 ? (totalProfit / totalStake) * 100 : 0

  // Racha actual
  let currentStreak: { type: 'WON' | 'LOST'; count: number } | null = null
  if (recentSettled.length > 0) {
    const isWin    = (r: { status: string }) => r.status === 'WON'
    const firstWin = isWin(recentSettled[0]!)
    let count      = 0
    for (const r of recentSettled) {
      if (isWin(r) === firstWin) count++
      else break
    }
    currentStreak = { type: firstWin ? 'WON' : 'LOST', count }
  }

  return NextResponse.json({
    period,
    settled:      settled.length,
    won,
    winRate:      Math.round(winRate * 10) / 10,
    totalProfit:  Math.round(totalProfit * 100) / 100,
    roi:          Math.round(roi * 100) / 100,
    openCount,
    currentStreak,
  })
}
