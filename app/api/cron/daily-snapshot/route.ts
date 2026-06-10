import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'

/**
 * GET /api/cron/daily-snapshot
 *
 * Computes and upserts a DailySnapshot + DailySnapshotByType for yesterday (UTC)
 * for every user who has at least one active bookmaker.
 *
 * Idempotent — safe to re-run for the same day (upsert).
 * Called by Vercel Cron daily at 02:00 UTC (see vercel.json).
 * Authenticated with CRON_SECRET header (Bearer token).
 */

const SETTLED = ['WON', 'LOST', 'VOID', 'CASHOUT', 'PARTIAL_WIN'] as const

export async function GET(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // yesterday UTC — full day window
  const utcNow     = new Date()
  const yday       = new Date(Date.UTC(utcNow.getUTCFullYear(), utcNow.getUTCMonth(), utcNow.getUTCDate() - 1))
  const todayStart = new Date(Date.UTC(utcNow.getUTCFullYear(), utcNow.getUTCMonth(), utcNow.getUTCDate()))
  const ydayEnd    = new Date(todayStart.getTime() - 1) // 23:59:59.999 UTC yesterday

  const users = await prisma.user.findMany({
    where: { bookmakers: { some: { deletedAt: null, status: 'ACTIVE' } } },
    select: { id: true },
  })

  let created = 0
  let errors  = 0

  for (const { id: userId } of users) {
    try {
      const [
        staked,
        settled,
        deposited,
        withdrawn,
        cumStaked,
        cumSettled,
        cumDeposited,
        cumWithdrawn,
        balances,
        inPlay,
        dailyByType,
      ] = await Promise.all([
        // placed yesterday
        prisma.betRecord.aggregate({
          where: { userId, deletedAt: null, status: { not: 'DRAFT' }, datePlaced: { gte: yday, lt: todayStart } },
          _sum: { totalStake: true },
        }),
        // settled yesterday
        prisma.betRecord.aggregate({
          where: { userId, deletedAt: null, status: { in: SETTLED as unknown as ('WON' | 'LOST' | 'VOID' | 'CASHOUT' | 'PARTIAL_WIN')[] }, dateSettled: { gte: yday, lt: todayStart } },
          _sum: { grossProfit: true, totalReturn: true },
          _count: { _all: true },
        }),
        // deposited yesterday
        prisma.bookmakerTransaction.aggregate({
          where: { userId, type: { in: ['INITIAL_DEPOSIT', 'DEPOSIT'] }, createdAt: { gte: yday, lt: todayStart } },
          _sum: { amount: true },
        }),
        // withdrawn yesterday
        prisma.bookmakerTransaction.aggregate({
          where: { userId, type: 'WITHDRAWAL', createdAt: { gte: yday, lt: todayStart } },
          _sum: { amount: true },
        }),
        // cumulative staked through yesterday
        prisma.betRecord.aggregate({
          where: { userId, deletedAt: null, status: { not: 'DRAFT' }, datePlaced: { lte: ydayEnd } },
          _sum: { totalStake: true },
        }),
        // cumulative settled through yesterday
        prisma.betRecord.aggregate({
          where: { userId, deletedAt: null, status: { in: SETTLED as unknown as ('WON' | 'LOST' | 'VOID' | 'CASHOUT' | 'PARTIAL_WIN')[] }, dateSettled: { lte: ydayEnd } },
          _sum: { grossProfit: true },
          _count: { _all: true },
        }),
        // cumulative deposited through yesterday
        prisma.bookmakerTransaction.aggregate({
          where: { userId, type: { in: ['INITIAL_DEPOSIT', 'DEPOSIT'] }, createdAt: { lte: ydayEnd } },
          _sum: { amount: true },
        }),
        // cumulative withdrawn through yesterday
        prisma.bookmakerTransaction.aggregate({
          where: { userId, type: 'WITHDRAWAL', createdAt: { lte: ydayEnd } },
          _sum: { amount: true },
        }),
        // current balances (best approximation of end-of-yesterday state)
        prisma.bookmaker.aggregate({
          where: { userId, deletedAt: null, status: 'ACTIVE' },
          _sum: { currentBalance: true },
        }),
        // currently in play
        prisma.betRecord.aggregate({
          where: { userId, deletedAt: null, status: 'PLACED' },
          _sum: { totalStake: true },
        }),
        // daily breakdown by bet type
        prisma.betRecord.groupBy({
          by: ['type'],
          where: { userId, deletedAt: null, status: { in: SETTLED as unknown as ('WON' | 'LOST' | 'VOID' | 'CASHOUT' | 'PARTIAL_WIN')[] }, dateSettled: { gte: yday, lt: todayStart } },
          _sum: { grossProfit: true, totalStake: true, totalReturn: true },
          _count: { _all: true },
        }),
      ])

      const totalBal  = Number(balances._sum.currentBalance ?? 0)
      const inPlayBal = Number(inPlay._sum.totalStake ?? 0)

      const snapData = {
        totalEffectiveBalance: totalBal,
        totalAvailableBalance: Math.max(0, totalBal - inPlayBal),
        totalInPlay:           inPlayBal,
        dailyDeposited:        Number(deposited._sum.amount    ?? 0),
        dailyWithdrawn:        Number(withdrawn._sum.amount    ?? 0),
        dailyProfit:           Number(settled._sum.grossProfit ?? 0),
        dailyStaked:           Number(staked._sum.totalStake   ?? 0),
        dailyReturn:           Number(settled._sum.totalReturn ?? 0),
        dailyOperations:       settled._count._all,
        cumulativeProfit:      Number(cumSettled._sum.grossProfit ?? 0),
        cumulativeStaked:      Number(cumStaked._sum.totalStake   ?? 0),
        cumulativeDeposited:   Number(cumDeposited._sum.amount    ?? 0),
        cumulativeWithdrawn:   Number(cumWithdrawn._sum.amount    ?? 0),
        cumulativeOperations:  cumSettled._count._all,
      }

      const snap = await prisma.dailySnapshot.upsert({
        where:  { userId_date: { userId, date: yday } },
        create: { userId, date: yday, ...snapData },
        update: snapData,
      })

      // upsert per-type breakdown
      for (const row of dailyByType) {
        const typeData = {
          dailyProfit:     Number(row._sum.grossProfit ?? 0),
          dailyStaked:     Number(row._sum.totalStake  ?? 0),
          dailyReturn:     Number(row._sum.totalReturn ?? 0),
          dailyOperations: row._count._all,
        }
        await prisma.dailySnapshotByType.upsert({
          where:  { snapshotId_type: { snapshotId: snap.id, type: row.type } },
          create: { snapshotId: snap.id, type: row.type, ...typeData },
          update: typeData,
        })
      }

      created++
    } catch (e) {
      console.error(`[cron/daily-snapshot] user ${userId}:`, e)
      errors++
    }
  }

  return NextResponse.json({
    ok:      true,
    date:    yday.toISOString().slice(0, 10),
    created,
    errors,
    total:   users.length,
  })
}
