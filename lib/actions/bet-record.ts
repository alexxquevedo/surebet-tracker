'use server'

import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import Decimal from 'decimal.js'
import type { BetType, BetStatus } from '@/types/domain'
import { sendSettleEmail } from '@/lib/services/email'

export type BetActionResult = { success: true; id: string } | { success: false; error: string }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function D(v: unknown): Decimal {
  return new Decimal(String(v ?? 0))
}

const VALID_TYPES: readonly BetType[] = [
  'ARBITRAGE', 'MIDDLE', 'SINGLE', 'COMBO', 'CASINO', 'CUSTOM',
] as const

const SPORT_LABELS: Record<string, string> = {
  FOOTBALL: 'Fútbol', BASKETBALL: 'Baloncesto', TENNIS: 'Tenis',
  HOCKEY: 'Hockey', BASEBALL: 'Béisbol', RUGBY: 'Rugby',
  CRICKET: 'Cricket', GOLF: 'Golf', MMA: 'MMA', BOXING: 'Boxeo',
  MOTORSPORT: 'Motor', ESPORTS: 'eSports', OTHER: 'Otro',
}

/** Genera un título automático cuando el usuario no introduce uno. */
function autoTitle(type: BetType, sport: string | null, date: Date): string {
  const typeLabel: Record<BetType, string> = {
    ARBITRAGE: 'Surebets', MIDDLE: 'Middlebet', SINGLE: 'Single',
    COMBO: 'Combo', CASINO: 'Casino', CUSTOM: 'Custom',
  }
  const sportStr = sport ? ` · ${SPORT_LABELS[sport] ?? sport}` : ''
  const dateStr  = date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' })
  return `${typeLabel[type]}${sportStr} · ${dateStr}`
}

/** Parsea el campo datePlaced del formulario; si falta o es inválido, usa now(). */
function parseDatePlaced(raw: string | null): Date {
  if (!raw) return new Date()
  const d = new Date(raw)
  return isNaN(d.getTime()) ? new Date() : d
}

// Límites del plan FREE
const FREE_BET_LIMIT        = 50
const FREE_BOOKMAKER_LIMIT  = 3

/** Comprueba si el usuario FREE ha alcanzado el límite de apuestas. */
async function checkFreeBetLimit(userId: string, plan: string): Promise<string | null> {
  if (plan !== 'FREE') return null
  const count = await prisma.betRecord.count({ where: { userId, deletedAt: null } })
  if (count >= FREE_BET_LIMIT)
    return `Plan FREE: límite de ${FREE_BET_LIMIT} operaciones alcanzado. Actualiza a PRO para registros ilimitados.`
  return null
}

// ════════════════════════════════════════════════════════════════════════════
// createQuickBetAction  — apuesta simple (un solo bookmaker)
// ════════════════════════════════════════════════════════════════════════════

export async function createQuickBetAction(formData: FormData): Promise<BetActionResult> {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const userPlan  = (session?.user as { plan?: string })?.plan ?? 'FREE'
  const limitErr  = await checkFreeBetLimit(userId, userPlan)
  if (limitErr) return { success: false, error: limitErr }

  const rawType     = formData.get('type') as string | null
  const bookmakerId = formData.get('bookmakerId') as string | null
  const rawStake    = formData.get('stake') as string | null
  const rawOdds     = formData.get('odds') as string | null
  const selection   = ((formData.get('selection') as string | null) ?? '').trim()
  const rawSport    = (formData.get('sport') as string | null)?.trim() || null
  const isLive      = formData.get('isLive') === 'true'
  const datePlaced  = parseDatePlaced(formData.get('datePlaced') as string | null)

  if (!rawType || !VALID_TYPES.includes(rawType as BetType)) {
    return { success: false, error: 'Tipo de apuesta inválido' }
  }
  if (!bookmakerId) return { success: false, error: 'Casa de apuestas requerida' }

  const stakeNum = parseFloat(rawStake ?? '')
  const oddsNum  = parseFloat(rawOdds  ?? '')
  if (isNaN(stakeNum) || stakeNum <= 0) return { success: false, error: 'Stake inválido' }
  if (isNaN(oddsNum)  || oddsNum < 1.01) return { success: false, error: 'Cuota inválida (mín. 1.01)' }

  const betType   = rawType as BetType
  const stake     = D(stakeNum).toDecimalPlaces(2)
  const odds      = D(oddsNum).toDecimalPlaces(4)
  const potReturn = stake.mul(odds).toDecimalPlaces(2)
  const finalTitle = selection || autoTitle(betType, rawSport, datePlaced)

  try {
    const record = await prisma.$transaction(async (tx) => {
      const bm = await tx.bookmaker.findFirst({
        where: { id: bookmakerId, userId },
        select: { id: true, currentBalance: true },
      })
      if (!bm) throw new Error('Casa de apuestas no encontrada')

      let created: { id: string }

      if (betType === 'SINGLE') {
        created = await tx.betRecord.create({
          data: {
            userId, type: 'SINGLE', status: 'PLACED',
            totalStake: stake, potentialReturn: potReturn,
            datePlaced, createdVia: 'MANUAL',
            isLive,
            sport: rawSport as Parameters<typeof tx.betRecord.create>[0]['data']['sport'] ?? undefined,
            primaryBookmakerId: bookmakerId,
            title: finalTitle,
            singleBetDetail: {
              create: { selection: selection || finalTitle, odds, marketType: 'OTHER', isFreeBet: false },
            },
          },
          select: { id: true },
        })
      } else {
        created = await tx.betRecord.create({
          data: {
            userId, type: betType, status: 'PLACED',
            totalStake: stake, potentialReturn: potReturn,
            datePlaced, createdVia: 'MANUAL',
            isLive,
            sport: rawSport as Parameters<typeof tx.betRecord.create>[0]['data']['sport'] ?? undefined,
            primaryBookmakerId: bookmakerId,
            title: finalTitle,
          },
          select: { id: true },
        })
      }

      await tx.bookmaker.update({
        where: { id: bookmakerId },
        data: { currentBalance: D(bm.currentBalance).minus(stake), totalStaked: { increment: stake.toNumber() } },
      })

      return created
    })

    return { success: true, id: record.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// createMultiLegBetAction  — Surebets (ARBITRAGE) y Middlebet (MIDDLE)
// ════════════════════════════════════════════════════════════════════════════

export async function createMultiLegBetAction(formData: FormData): Promise<BetActionResult> {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const userPlan  = (session?.user as { plan?: string })?.plan ?? 'FREE'
  const limitErr  = await checkFreeBetLimit(userId, userPlan)
  if (limitErr) return { success: false, error: limitErr }

  const rawType   = formData.get('type') as string | null
  const bm1Id     = formData.get('bm1Id') as string | null
  const bm2Id     = formData.get('bm2Id') as string | null
  const rawS1     = formData.get('stake1') as string | null
  const rawO1     = formData.get('odds1') as string | null
  const rawS2     = formData.get('stake2') as string | null
  const rawO2     = formData.get('odds2') as string | null
  const selection  = ((formData.get('selection') as string | null) ?? '').trim()
  const middleRange = ((formData.get('middleRange') as string | null) ?? '').trim()
  const rawSport   = (formData.get('sport') as string | null)?.trim() || null
  const isLive     = formData.get('isLive') === 'true'
  const datePlaced = parseDatePlaced(formData.get('datePlaced') as string | null)

  if (rawType !== 'ARBITRAGE' && rawType !== 'MIDDLE') {
    return { success: false, error: 'Tipo debe ser ARBITRAGE o MIDDLE' }
  }
  if (!bm1Id || !bm2Id) return { success: false, error: 'Ambas casas de apuestas son requeridas' }

  const s1 = parseFloat(rawS1 ?? ''), o1 = parseFloat(rawO1 ?? '')
  const s2 = parseFloat(rawS2 ?? ''), o2 = parseFloat(rawO2 ?? '')

  if ([s1, o1, s2, o2].some(isNaN) || s1 <= 0 || s2 <= 0) {
    return { success: false, error: 'Stakes y cuotas son obligatorios y deben ser válidos' }
  }
  if (o1 < 1.01 || o2 < 1.01) {
    return { success: false, error: 'Las cuotas deben ser ≥ 1.01' }
  }

  const stake1 = D(s1).toDecimalPlaces(2), odds1 = D(o1).toDecimalPlaces(4)
  const stake2 = D(s2).toDecimalPlaces(2), odds2 = D(o2).toDecimalPlaces(4)
  const ret1   = stake1.mul(odds1).toDecimalPlaces(2)
  const ret2   = stake2.mul(odds2).toDecimalPlaces(2)
  const totalStake    = stake1.plus(stake2).toDecimalPlaces(2)
  const betType       = rawType as 'ARBITRAGE' | 'MIDDLE'
  const finalTitle    = selection || autoTitle(betType, rawSport, datePlaced)

  // Surebet guaranteed return = min of both returns
  const guaranteedRet  = Decimal.min(ret1, ret2).toDecimalPlaces(2)
  const guaranteedProfit = guaranteedRet.minus(totalStake).toDecimalPlaces(2)
  const arbPct        = totalStake.isZero() ? D(0) : guaranteedProfit.div(totalStake).mul(100).toDecimalPlaces(4)

  // Middle: best case = both sides win
  const middleBestCase  = ret1.plus(ret2).minus(totalStake).toDecimalPlaces(2)
  const middleWorstCase = Decimal.max(ret1, ret2).minus(totalStake).toDecimalPlaces(2) // worst = better losing leg

  try {
    const record = await prisma.$transaction(async (tx) => {
      // Verify both bookmakers
      const bm1 = await tx.bookmaker.findFirst({ where: { id: bm1Id, userId }, select: { id: true, currentBalance: true } })
      const bm2 = await tx.bookmaker.findFirst({ where: { id: bm2Id, userId }, select: { id: true, currentBalance: true } })
      if (!bm1) throw new Error('Casa 1 no encontrada')
      if (!bm2) throw new Error('Casa 2 no encontrada')

      // Create the BetRecord
      const created = await tx.betRecord.create({
        data: {
          userId,
          type:           betType,
          status:         'PLACED',
          totalStake,
          potentialReturn: betType === 'ARBITRAGE' ? guaranteedRet : ret1.plus(ret2).toDecimalPlaces(2),
          datePlaced,
          createdVia:     'MANUAL',
          isLive,
          sport: rawSport as Parameters<typeof tx.betRecord.create>[0]['data']['sport'] ?? undefined,
          title: finalTitle,
          // Create type-specific detail
          ...(betType === 'ARBITRAGE' ? {
            arbitrageDetail: {
              create: { arbPercentage: arbPct, expectedReturn: guaranteedRet },
            },
          } : {
            middleDetail: {
              create: {
                middleRange:    middleRange || 'Sin especificar',
                worstCaseLoss:  middleWorstCase,
                bestCaseProfit: middleBestCase,
              },
            },
          }),
          // Create the two legs
          legs: {
            createMany: {
              data: [
                { bookmakerId: bm1Id, selection: selection || `Leg 1`, odds: odds1, stake: stake1, potentialReturn: ret1, currency: 'EUR' },
                { bookmakerId: bm2Id, selection: selection || `Leg 2`, odds: odds2, stake: stake2, potentialReturn: ret2, currency: 'EUR' },
              ],
            },
          },
        },
        select: { id: true },
      })

      // Deduct stakes from both bookmakers
      await tx.bookmaker.update({ where: { id: bm1Id }, data: { currentBalance: D(bm1.currentBalance).minus(stake1), totalStaked: { increment: stake1.toNumber() } } })
      await tx.bookmaker.update({ where: { id: bm2Id }, data: { currentBalance: D(bm2.currentBalance).minus(stake2), totalStaked: { increment: stake2.toNumber() } } })

      return created
    })

    return { success: true, id: record.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error al registrar la operación' }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// settleBetAction  — liquidar una operación en juego
// ════════════════════════════════════════════════════════════════════════════

export async function settleBetAction(formData: FormData): Promise<BetActionResult> {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const betRecordId = formData.get('betRecordId') as string | null
  const outcome     = formData.get('outcome') as string | null       // 'WON'|'LOST'|'VOID'|'CASHOUT'
  const winningLeg  = formData.get('winningLeg') as string | null    // '1'|'2'|'BOTH'
  const rawCashout  = formData.get('cashoutAmount') as string | null

  if (!betRecordId) return { success: false, error: 'ID de operación requerido' }
  if (!outcome) return { success: false, error: 'Resultado requerido' }

  // Fetch user email + notification prefs in parallel (fire-and-forget settle email later)
  const [userRow, userPrefs] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } }),
    prisma.userSettings.findUnique({ where: { userId }, select: { emailOnSettle: true } }),
  ])

  function maybeEmailSettle(status: string, stake: number, profit: number) {
    if (userRow?.email && userPrefs?.emailOnSettle !== false) {
      void sendSettleEmail(userRow.email!, userRow.name ?? null, { status, stake, profit }).catch(console.error)
    }
  }

  try {
    // Fetch the bet with legs and detail
    const bet = await prisma.betRecord.findFirst({
      where: { id: betRecordId, userId, status: 'PLACED', deletedAt: null },
      select: {
        id: true,
        type: true,
        totalStake: true,
        primaryBookmakerId: true,
        singleBetDetail: { select: { odds: true } },
        legs: {
          where: { deletedAt: null },
          orderBy: { id: 'asc' },
          select: { id: true, bookmakerId: true, stake: true, odds: true, potentialReturn: true },
        },
      },
    })

    if (!bet) return { success: false, error: 'Operación no encontrada o ya liquidada' }

    const betType   = bet.type as BetType
    const totalStake = D(bet.totalStake)
    const now        = new Date()

    // ── Calculate settlement financials ──────────────────────────────────────

    let grossProfit: Decimal
    let totalReturn: Decimal
    let finalStatus: BetStatus
    let returnBookmakerId: string | null   = null
    let returnAmount: Decimal | null       = null
    let txType: string | null             = null

    if (outcome === 'VOID') {
      // Anulada — devuelve el stake
      grossProfit          = D(0)
      totalReturn          = totalStake
      finalStatus          = 'VOID'
      txType               = 'BET_VOID_RETURN'
      returnBookmakerId    = bet.primaryBookmakerId
      returnAmount         = totalStake

    } else if (outcome === 'CASHOUT') {
      const cashout   = D(parseFloat(rawCashout ?? '0'))
      grossProfit     = cashout.minus(totalStake).toDecimalPlaces(2)
      totalReturn     = cashout
      finalStatus     = 'CASHOUT'
      txType          = 'CASHOUT'
      returnBookmakerId = bet.primaryBookmakerId
      returnAmount      = cashout

    } else if (betType === 'ARBITRAGE' || betType === 'MIDDLE') {
      // Multi-leg settlement
      const leg1 = bet.legs[0]
      const leg2 = bet.legs[1]
      if (!leg1 || !leg2) return { success: false, error: 'Piernas no encontradas' }

      const ret1 = D(leg1.potentialReturn)
      const ret2 = D(leg2.potentialReturn)

      if (betType === 'MIDDLE' && winningLeg === 'BOTH') {
        // Middle hit: both legs win
        grossProfit       = ret1.plus(ret2).minus(totalStake).toDecimalPlaces(2)
        totalReturn       = ret1.plus(ret2).toDecimalPlaces(2)
        finalStatus       = 'WON'
        // Update both bookmakers
        txType            = null // handled separately below
      } else if (winningLeg === '1') {
        grossProfit       = ret1.minus(totalStake).toDecimalPlaces(2)
        totalReturn       = ret1
        finalStatus       = grossProfit.gte(0) ? 'WON' : 'LOST'
        returnBookmakerId = leg1.bookmakerId
        returnAmount      = ret1
        txType            = 'BET_RETURN'
      } else {
        // winningLeg === '2'
        grossProfit       = ret2.minus(totalStake).toDecimalPlaces(2)
        totalReturn       = ret2
        finalStatus       = grossProfit.gte(0) ? 'WON' : 'LOST'
        returnBookmakerId = leg2.bookmakerId
        returnAmount      = ret2
        txType            = 'BET_RETURN'
      }

      // Special: middle BOTH — handle in transaction
      if (betType === 'MIDDLE' && winningLeg === 'BOTH') {
        await prisma.$transaction(async (tx) => {
          await tx.betRecord.update({
            where: { id: betRecordId },
            data: {
              status: 'WON',
              grossProfit: grossProfit,
              totalReturn: totalReturn,
              roi: totalStake.isZero() ? D(0) : grossProfit.div(totalStake).mul(100).toDecimalPlaces(4),
              dateSettled: now,
              middleDetail: { update: { middleHit: true } },
            },
          })
          await tx.betRecord.updateMany({ where: { id: betRecordId }, data: {} }) // noop to keep tx

          // Return both legs
          const bm1 = await tx.bookmaker.findUnique({ where: { id: leg1.bookmakerId }, select: { currentBalance: true } })
          const bm2 = await tx.bookmaker.findUnique({ where: { id: leg2.bookmakerId }, select: { currentBalance: true } })
          if (bm1) {
            await tx.bookmaker.update({ where: { id: leg1.bookmakerId }, data: { currentBalance: D(bm1.currentBalance).plus(ret1), totalProfit: { increment: ret1.minus(D(leg1.stake)).toNumber() }, totalReturn: { increment: ret1.toNumber() } } })
            await tx.bookmakerTransaction.create({ data: { userId, bookmakerId: leg1.bookmakerId, type: 'BET_RETURN', amount: ret1, balanceBefore: D(bm1.currentBalance), balanceAfter: D(bm1.currentBalance).plus(ret1), currency: 'EUR', referenceId: betRecordId, referenceType: 'BetRecord' } })
          }
          if (bm2) {
            await tx.bookmaker.update({ where: { id: leg2.bookmakerId }, data: { currentBalance: D(bm2.currentBalance).plus(ret2), totalProfit: { increment: ret2.minus(D(leg2.stake)).toNumber() }, totalReturn: { increment: ret2.toNumber() } } })
            await tx.bookmakerTransaction.create({ data: { userId, bookmakerId: leg2.bookmakerId, type: 'BET_RETURN', amount: ret2, balanceBefore: D(bm2.currentBalance), balanceAfter: D(bm2.currentBalance).plus(ret2), currency: 'EUR', referenceId: betRecordId, referenceType: 'BetRecord' } })
          }
        })
        maybeEmailSettle('WON', totalStake.toNumber(), grossProfit.toNumber())
        return { success: true, id: betRecordId }
      }

    } else {
      // SINGLE / CASINO / COMBO / CUSTOM
      const singleOdds = D(bet.singleBetDetail?.odds ?? 2)

      if (outcome === 'WON') {
        grossProfit       = totalStake.mul(singleOdds.minus(1)).toDecimalPlaces(2)
        totalReturn       = totalStake.mul(singleOdds).toDecimalPlaces(2)
        finalStatus       = 'WON'
        returnBookmakerId = bet.primaryBookmakerId
        returnAmount      = totalReturn
        txType            = 'BET_RETURN'
      } else {
        // LOST
        grossProfit       = totalStake.neg().toDecimalPlaces(2)
        totalReturn       = D(0)
        finalStatus       = 'LOST'
        // No return — stake already deducted
      }
    }

    // ── Commit to DB ─────────────────────────────────────────────────────────

    await prisma.$transaction(async (tx) => {
      await tx.betRecord.update({
        where: { id: betRecordId },
        data: {
          status:      finalStatus,
          grossProfit,
          totalReturn,
          roi: totalStake.isZero() ? D(0) : grossProfit.div(totalStake).mul(100).toDecimalPlaces(4),
          dateSettled: now,
        },
      })

      if (returnBookmakerId && returnAmount && returnAmount.gt(0)) {
        const bm = await tx.bookmaker.findUnique({
          where: { id: returnBookmakerId },
          select: { currentBalance: true },
        })
        if (bm) {
          const balBefore = D(bm.currentBalance)
          const balAfter  = balBefore.plus(returnAmount)
          const profit    = grossProfit
          await tx.bookmaker.update({
            where: { id: returnBookmakerId },
            data: {
              currentBalance: balAfter,
              totalProfit: { increment: profit.toNumber() },
              totalReturn: { increment: returnAmount.toNumber() },
            },
          })
          if (txType) {
            await tx.bookmakerTransaction.create({
              data: {
                userId,
                bookmakerId:   returnBookmakerId,
                type:          txType as 'BET_RETURN' | 'BET_VOID_RETURN' | 'CASHOUT',
                amount:        returnAmount,
                balanceBefore: balBefore,
                balanceAfter:  balAfter,
                currency:      'EUR',
                referenceId:   betRecordId,
                referenceType: 'BetRecord',
              },
            })
          }
        }
      } else if (finalStatus === 'LOST' && bet.primaryBookmakerId) {
        // Record the loss on the bookmaker (profit decrement)
        await tx.bookmaker.update({
          where: { id: bet.primaryBookmakerId },
          data: { totalProfit: { increment: grossProfit.toNumber() } }, // grossProfit is negative
        })
      }
    })

    maybeEmailSettle(finalStatus, totalStake.toNumber(), grossProfit.toNumber())
    return { success: true, id: betRecordId }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error al liquidar la operación' }
  }
}
