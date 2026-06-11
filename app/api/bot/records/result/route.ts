import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'
import Decimal from 'decimal.js'
import type { BetStatus } from '@prisma/client'

/**
 * POST /api/bot/records/result
 *
 * Liquida un BetRecord creado por el bot con el resultado real.
 * Actualiza estado, P&L, piernas y balances de bookmakers.
 *
 * Body:
 * {
 *   telegram_id:    number,
 *   apuesta_id:     string,   // bot_pending_id — identifica el BetRecord
 *   resultado:      "WON" | "LOST" | "VOID" | "CASHOUT",
 *   ganancia_real?: number,   // P&L real (positivo = ganancia, negativo = pérdida)
 *   legs_resultado?: [{ leg: number, estado: "WON" | "LOST" | "VOID" }]
 * }
 */

const VALID_RESULTS = new Set<string>(['WON', 'LOST', 'VOID', 'CASHOUT'])

function D(v: unknown): Decimal {
  return new Decimal(String(v ?? 0))
}

export async function POST(request: NextRequest) {
  if (!verifyBotSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    telegram_id?:     unknown
    apuesta_id?:      string
    resultado?:       string
    ganancia_real?:   number
    cashout_amount?:  number   // importe total (fallback)
    per_leg_cashout?: Array<{ leg: number; amount: number }>  // cashout por pierna
    legs_resultado?:  Array<{ leg: number; estado: string }>
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { telegram_id, apuesta_id, resultado, ganancia_real, cashout_amount, per_leg_cashout, legs_resultado } = body

  if (!telegram_id || !apuesta_id || !resultado) {
    return NextResponse.json(
      { error: 'telegram_id, apuesta_id and resultado are required' },
      { status: 400 },
    )
  }
  if (!VALID_RESULTS.has(resultado)) {
    return NextResponse.json({ error: 'Invalid resultado value' }, { status: 400 })
  }

  const telegramIdStr = String(telegram_id)

  // ── Verificar usuario ────────────────────────────────────
  const user = await prisma.user.findUnique({
    where:  { telegramId: telegramIdStr },
    select: { id: true },
  })
  if (!user) {
    return NextResponse.json({ error: 'USER_NOT_LINKED' }, { status: 404 })
  }

  // ── Buscar el BetRecord por botPendingId ─────────────────
  const betRecord = await prisma.betRecord.findUnique({
    where:  { botPendingId: apuesta_id },
    include: {
      legs: {
        select: {
          id: true,
          bookmakerId: true,
          stake: true,
          odds: true,
          potentialReturn: true,
        },
      },
      allocations: {
        select: { id: true, bookmakerId: true },
      },
    },
  })

  if (!betRecord) {
    // Si no existe en la web (ej. API no estaba activa cuando se registró), no es error crítico
    return NextResponse.json(
      { error: 'RECORD_NOT_FOUND', message: 'Registro no encontrado en DualStats' },
      { status: 404 },
    )
  }
  if (betRecord.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (betRecord.status !== 'PLACED') {
    // Ya liquidada — idempotente, no es error
    return NextResponse.json({ success: true, id: betRecord.id, alreadySettled: true })
  }

  const newStatus = resultado as BetStatus
  const now       = new Date()

  // ── Calcular P&L real ────────────────────────────────────
  // Si el bot envía ganancia_real la usamos directamente;
  // si no, calculamos desde los datos de las piernas.
  let grossProfit: Decimal
  let totalReturn: Decimal

  const totalStake = D(betRecord.totalStake)

  if (newStatus === 'CASHOUT' && per_leg_cashout !== undefined && per_leg_cashout.length > 0) {
    // Cashout per-pierna: sumar todos los importes
    totalReturn = per_leg_cashout.reduce((a, plc) => a.plus(D(plc.amount)), D(0)).toDecimalPlaces(2)
    grossProfit = totalReturn.minus(totalStake).toDecimalPlaces(2)
  } else if (newStatus === 'CASHOUT' && cashout_amount !== undefined && cashout_amount !== null) {
    // Cashout total (fallback para clientes legacy)
    totalReturn = D(cashout_amount).toDecimalPlaces(2)
    grossProfit = totalReturn.minus(totalStake).toDecimalPlaces(2)
  } else if (ganancia_real !== undefined && ganancia_real !== null) {
    grossProfit = D(ganancia_real).toDecimalPlaces(2)
    totalReturn = totalStake.plus(grossProfit).toDecimalPlaces(2)
  } else if (newStatus === 'LOST') {
    grossProfit = totalStake.negated().toDecimalPlaces(2)
    totalReturn = D(0)
  } else if (newStatus === 'VOID') {
    grossProfit = D(0)
    totalReturn = totalStake
  } else {
    // WON sin ganancia_real: usamos potentialReturn
    totalReturn = D(betRecord.potentialReturn ?? betRecord.totalStake)
    grossProfit = totalReturn.minus(totalStake).toDecimalPlaces(2)
  }

  const roi = totalStake.isZero()
    ? D(0)
    : grossProfit.div(totalStake).mul(100).toDecimalPlaces(4)

  // ── Estado por pierna ────────────────────────────────────
  const legStatusMap = new Map<number, BetStatus>()
  if (legs_resultado) {
    for (const lr of legs_resultado) {
      const s = lr.estado as BetStatus
      if (VALID_RESULTS.has(s)) legStatusMap.set(lr.leg, s)
    }
  }
  // Fallback: si no hay detalle por pierna, todas = estado global
  for (let i = 0; i < betRecord.legs.length; i++) {
    if (!legStatusMap.has(i)) legStatusMap.set(i, newStatus)
  }

  try {
    await prisma.$transaction(async (tx) => {
      // ── Actualizar BetRecord ─────────────────────────────
      await tx.betRecord.update({
        where: { id: betRecord.id },
        data:  {
          status:      newStatus,
          grossProfit,
          totalReturn,
          roi,
          dateSettled: now,
        },
      })

      // ── Guardar pierna ganadora en el detalle del tipo ───
      if (betRecord.type === 'ARBITRAGE') {
        const winnerIdx = betRecord.legs.findIndex((_, i) => (legStatusMap.get(i) ?? newStatus) === 'WON')
        const winningLegId = winnerIdx >= 0 ? (betRecord.legs[winnerIdx]?.id ?? null) : null
        if (winningLegId) {
          await tx.arbitrageDetail.updateMany({
            where: { betRecordId: betRecord.id },
            data:  { winningLegId },
          })
        }
      } else if (betRecord.type === 'MIDDLE') {
        const wonLegs   = betRecord.legs.filter((_, i) => (legStatusMap.get(i) ?? newStatus) === 'WON')
        const middleHit = wonLegs.length === betRecord.legs.length && betRecord.legs.length >= 2
        await tx.middleDetail.updateMany({
          where: { betRecordId: betRecord.id },
          data:  {
            middleHit,
            winningLegId: middleHit ? null : (wonLegs[0]?.id ?? null),
          },
        })
      }

      // ── Actualizar piernas y bookmakers ──────────────────
      for (let i = 0; i < betRecord.legs.length; i++) {
        const leg       = betRecord.legs[i]!
        const legStatus = legStatusMap.get(i) ?? newStatus

        // Actualizar estado de la pierna
        await tx.betLeg.update({
          where: { id: leg.id },
          data:  { status: legStatus },
        })

        // Calcular retorno de esta pierna
        let legReturn: Decimal
        if (legStatus === 'WON') {
          legReturn = D(leg.potentialReturn).toDecimalPlaces(2)
        } else if (legStatus === 'VOID') {
          legReturn = D(leg.stake).toDecimalPlaces(2) // stake devuelto
        } else if (newStatus === 'CASHOUT') {
          // Cashout: usar importe por pierna si se envió, si no distribuir proporcional
          const plcEntry = per_leg_cashout?.find(plc => plc.leg === i)
          if (plcEntry !== undefined) {
            legReturn = D(plcEntry.amount).toDecimalPlaces(2)
          } else if (totalReturn.gt(0) && !totalStake.isZero()) {
            legReturn = totalReturn.mul(D(leg.stake).div(totalStake)).toDecimalPlaces(2)
          } else {
            legReturn = D(0)
          }
        } else {
          legReturn = D(0)
        }
        const legStake  = D(leg.stake)
        const legProfit = legReturn.minus(legStake).toDecimalPlaces(2)

        // Actualizar allocation
        const alloc = betRecord.allocations.find((a) => a.bookmakerId === leg.bookmakerId)
        if (alloc) {
          await tx.betBookmakerAllocation.update({
            where: { id: alloc.id },
            data:  { returnAllocated: legReturn, profitAllocated: legProfit },
          })
        }

        // Leer saldo actual del bookmaker
        const bm = await tx.bookmaker.findUniqueOrThrow({
          where:  { id: leg.bookmakerId },
          select: { currentBalance: true },
        })
        const balBefore = D(bm.currentBalance)
        const balAfter  = balBefore.plus(legReturn).toDecimalPlaces(2)

        // Bookmaker: saldo + profit
        await tx.bookmaker.update({
          where: { id: leg.bookmakerId },
          data:  {
            currentBalance: { increment: legReturn.toNumber() },
            totalProfit:    { increment: legProfit.toNumber() },
            totalReturn:    { increment: legReturn.toNumber() },
          },
        })

        // Ledger de transacciones (solo si hay retorno)
        if (legReturn.greaterThan(0)) {
          await tx.bookmakerTransaction.create({
            data: {
              bookmakerId:   leg.bookmakerId,
              userId:        betRecord.userId,
              type:          legStatus === 'VOID' ? 'BET_VOID_RETURN' : newStatus === 'CASHOUT' ? 'CASHOUT' : 'BET_RETURN',
              amount:        legReturn,
              balanceBefore: balBefore,
              balanceAfter:  balAfter,
              referenceId:   betRecord.id,
              referenceType: 'BetRecord',
            },
          })
        }
      }
    })

    return NextResponse.json({ success: true, id: betRecord.id })
  } catch (err) {
    console.error('[POST /api/bot/records/result]', err)
    return NextResponse.json(
      { error: 'Internal error', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
