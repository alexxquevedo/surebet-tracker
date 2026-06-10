import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'
import Decimal from 'decimal.js'
import type { SportType } from '@prisma/client'

/**
 * POST /api/bot/records
 *
 * Crea un BetRecord desde FidesBot (ARBITRAGE o MIDDLE).
 * Incluye find-or-create de bookmakers por nombre, actualización
 * de balances y ledger de transacciones inmutable.
 *
 * Body:
 * {
 *   telegram_id:    number,
 *   bot_pending_id: string,   // UUID del bot — deduplicación
 *   apuesta: {
 *     evento:   string,
 *     sport:    string,       // sport_key del bot ("soccer", "tennis", …)
 *     liga:     string,
 *     legs:     [{ bookmaker, outcome, odd, stake }],
 *     profit:   number,       // ROI estimado %
 *     tipo:     "surebet" | "middlebet",
 *     fuente:   "telegram" | "auto",
 *     aproximado?: boolean,
 *   }
 * }
 */

// Mapeo sport_key del bot → SportType de Prisma
const SPORT_MAP: Record<string, SportType> = {
  soccer:                 'FOOTBALL',
  football:               'FOOTBALL',
  basketball:             'BASKETBALL',
  basketball_nba:         'BASKETBALL',
  basketball_ncaab:       'BASKETBALL',
  tennis:                 'TENNIS',
  americanfootball:       'OTHER',
  americanfootball_nfl:   'OTHER',
  americanfootball_ncaaf: 'OTHER',
  icehockey:              'HOCKEY',
  icehockey_nhl:          'HOCKEY',
  baseball:               'BASEBALL',
  baseball_mlb:           'BASEBALL',
  rugby:                  'RUGBY',
  rugby_union:            'RUGBY',
  rugby_league:           'RUGBY',
  golf:                   'GOLF',
  mma:                    'MMA',
  boxing:                 'BOXING',
  cricket:                'CRICKET',
  cycling:                'CYCLING',
  motorsport:             'MOTORSPORT',
  esports:                'ESPORTS',
}

function toSportType(key: string | undefined): SportType {
  if (!key) return 'OTHER'
  return SPORT_MAP[key.toLowerCase()] ?? 'OTHER'
}

function D(v: unknown): Decimal {
  return new Decimal(String(v ?? 0))
}

interface LegInput {
  bookmaker: string
  outcome:   string
  odd:       number
  stake:     number
}

// Pre-computa las cifras de una pierna para evitar indexado T|undefined
interface LegCalc {
  bookmakerName: string
  selection:     string
  stake:         Decimal
  odds:          Decimal
  potReturn:     Decimal
}

export async function POST(request: NextRequest) {
  if (!verifyBotSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    telegram_id?:    unknown
    bot_pending_id?: string
    apuesta?: {
      evento?:     string
      sport?:      string
      liga?:       string
      legs?:       LegInput[]
      profit?:     number
      tipo?:       string
      fuente?:     string
      aproximado?: boolean
    }
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { telegram_id, bot_pending_id, apuesta } = body

  if (!telegram_id || !apuesta) {
    return NextResponse.json({ error: 'telegram_id and apuesta are required' }, { status: 400 })
  }
  if (!Array.isArray(apuesta.legs) || apuesta.legs.length < 2) {
    return NextResponse.json({ error: 'At least 2 legs required' }, { status: 400 })
  }

  const telegramIdStr = String(telegram_id)

  // ── Verificar usuario vinculado con plan PRO ─────────────
  const user = await prisma.user.findUnique({
    where:  { telegramId: telegramIdStr },
    select: { id: true, plan: true, planExpiresAt: true },
  })
  if (!user) {
    return NextResponse.json(
      { error: 'USER_NOT_LINKED', message: 'Cuenta Telegram no vinculada' },
      { status: 404 },
    )
  }
  const hasActivePro =
    (user.plan === 'PRO' || user.plan === 'PRO_TRACKER' || user.plan === 'ENTERPRISE') &&
    (!user.planExpiresAt || user.planExpiresAt > new Date())
  if (!hasActivePro) {
    return NextResponse.json(
      { error: 'PRO_REQUIRED', message: 'Necesitas plan PRO en DualStats para registrar apuestas.' },
      { status: 403 },
    )
  }

  // ── Deduplicación por bot_pending_id ─────────────────────
  if (bot_pending_id) {
    const existing = await prisma.betRecord.findUnique({
      where:  { botPendingId: bot_pending_id },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json({ success: true, id: existing.id, duplicate: true })
    }
  }

  const userId     = user.id
  const betType    = apuesta.tipo === 'middlebet' ? 'MIDDLE' : 'ARBITRAGE'
  const sport      = toSportType(apuesta.sport)
  const isApprox   = apuesta.aproximado === true || apuesta.fuente === 'auto'

  // ── Buscar (o crear) bankroll FidesBot del usuario ───────────────────────
  // Normalmente se crea al vincular Telegram (/api/bot/connect), pero si el
  // usuario ya estaba vinculado antes de que se añadiera esta feature, lo
  // creamos aquí la primera vez que registre una apuesta.
  let fidesBot = await prisma.bankroll.findFirst({
    where:  { userId, isBot: true },
    select: { id: true },
  })
  if (!fidesBot) {
    fidesBot = await prisma.bankroll.create({
      data: {
        userId,
        name:        'FidesBot',
        description: 'Apuestas registradas desde el bot de Telegram',
        color:       '#2563eb',
        isBot:       true,
        isDefault:   false,
        isActive:    true,
      },
      select: { id: true },
    })
  }

  // Pre-calcular todas las cifras de las piernas (evita indexado T|undefined)
  const legCalcs: LegCalc[] = apuesta.legs.map((l) => {
    const stake    = D(l.stake).toDecimalPlaces(2)
    const odds     = D(l.odd).toDecimalPlaces(4)
    const potReturn = stake.mul(odds).toDecimalPlaces(2)
    return { bookmakerName: l.bookmaker.trim(), selection: l.outcome, stake, odds, potReturn }
  })

  const totalStake  = legCalcs.reduce((a, l) => a.plus(l.stake),    D(0)).toDecimalPlaces(2)
  const allReturns  = legCalcs.map((l) => l.potReturn)

  try {
    const record = await prisma.$transaction(async (tx) => {
      // ── Find-or-create bookmakers por nombre ─────────────
      const bmIds: string[] = []
      for (const lc of legCalcs) {
        let bm = await tx.bookmaker.findFirst({
          where:  { userId, name: { equals: lc.bookmakerName, mode: 'insensitive' } },
          select: { id: true },
        })
        if (!bm) {
          bm = await tx.bookmaker.create({
            data:   { userId, name: lc.bookmakerName, status: 'ACTIVE', currentBalance: 0 },
            select: { id: true },
          })
        }
        bmIds.push(bm.id)
      }

      // ── Detalle por tipo ─────────────────────────────────
      let potentialReturn: Decimal
      let typeDetail: object

      if (betType === 'ARBITRAGE') {
        potentialReturn = Decimal.min.apply(Decimal, allReturns).toDecimalPlaces(2)
        const guarProfit = potentialReturn.minus(totalStake).toDecimalPlaces(2)
        const arbPct     = totalStake.isZero()
          ? D(0)
          : guarProfit.div(totalStake).mul(100).toDecimalPlaces(4)
        typeDetail = {
          arbitrageDetail: {
            create: { arbPercentage: arbPct, expectedReturn: potentialReturn },
          },
        }
      } else {
        potentialReturn = allReturns.reduce((a, r) => a.plus(r), D(0)).toDecimalPlaces(2)
        const worstCase = Decimal.max.apply(Decimal, allReturns).minus(totalStake).toDecimalPlaces(2)
        const bestCase  = potentialReturn.minus(totalStake).toDecimalPlaces(2)
        typeDetail = {
          middleDetail: {
            create: {
              middleRange:    apuesta.evento ?? 'Middle',
              worstCaseLoss:  worstCase,
              bestCaseProfit: bestCase,
            },
          },
        }
      }

      const autoTitle =
        `${betType === 'ARBITRAGE' ? 'Surebet' : 'Middlebet'} · ${apuesta.evento ?? new Date().toLocaleDateString('es-ES')}`

      // ── Crear BetRecord ──────────────────────────────────
      const betRecord = await tx.betRecord.create({
        data: {
          userId,
          type:           betType,
          status:         'PLACED',
          totalStake,
          potentialReturn,
          eventName:      apuesta.evento  ?? null,
          competition:    apuesta.liga    ?? null,
          sport,
          datePlaced:     new Date(),
          createdVia:     'TELEGRAM_BOT',
          isApproximate:  isApprox,
          botPendingId:   bot_pending_id ?? null,
          title:          autoTitle,
          bankrollId:     fidesBot?.id ?? null,
          ...typeDetail,
        },
        select: { id: true },
      })

      // ── Crear piernas + actualizar bookmakers ────────────
      for (let i = 0; i < legCalcs.length; i++) {
        const lc   = legCalcs[i] as LegCalc   // siempre definido — loop hasta length
        const bmId = bmIds[i] as string        // siempre definido — mismo length

        // Leer saldo antes del decremento
        const bmNow = await tx.bookmaker.findUniqueOrThrow({
          where:  { id: bmId },
          select: { currentBalance: true },
        })
        let balBefore = D(bmNow.currentBalance)

        // ── Auto-ajuste: si el stake supera el saldo actual, subir el balance ──
        // Evita que el bookmaker quede en negativo cuando el usuario no había
        // introducido todavía su saldo inicial.
        if (balBefore.lt(lc.stake)) {
          const deficit = lc.stake.minus(balBefore).toDecimalPlaces(2)
          await tx.bookmaker.update({
            where: { id: bmId },
            data:  { currentBalance: { increment: deficit.toNumber() } },
          })
          await tx.bookmakerTransaction.create({
            data: {
              userId,
              bookmakerId:   bmId,
              type:          'MANUAL_ADJUSTMENT',
              amount:        deficit,
              balanceBefore: balBefore,
              balanceAfter:  balBefore.plus(deficit),
              notes:         'Ajuste automático — saldo insuficiente al registrar apuesta',
              referenceType: 'AutoAdjust',
            },
          })
          balBefore = balBefore.plus(deficit)
        }

        const balAfter = balBefore.minus(lc.stake).toDecimalPlaces(2)

        // Pierna
        await tx.betLeg.create({
          data: {
            betRecordId:    betRecord.id,
            bookmakerId:    bmId,
            selection:      lc.selection,
            odds:           lc.odds,
            stake:          lc.stake,
            potentialReturn: lc.potReturn,
            status:         'PLACED',
          },
        })

        // Estadísticas del bookmaker
        await tx.bookmaker.update({
          where: { id: bmId },
          data:  {
            currentBalance: { decrement: lc.stake.toNumber() },
            totalStaked:    { increment: lc.stake.toNumber() },
            operationCount: { increment: 1 },
          },
        })

        // Ledger (inmutable)
        await tx.bookmakerTransaction.create({
          data: {
            bookmakerId:   bmId,
            userId,
            type:          'BET_PLACED',
            amount:        lc.stake.negated(),
            balanceBefore: balBefore,
            balanceAfter:  balAfter,
            referenceId:   betRecord.id,
            referenceType: 'BetRecord',
          },
        })

        // Allocation para analytics O(1)
        await tx.betBookmakerAllocation.create({
          data: {
            betRecordId:    betRecord.id,
            bookmakerId:    bmId,
            stakeAllocated: lc.stake,
          },
        })
      }

      return betRecord
    })

    return NextResponse.json({ success: true, id: record.id }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/bot/records]', err)
    return NextResponse.json(
      { error: 'Internal error', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
