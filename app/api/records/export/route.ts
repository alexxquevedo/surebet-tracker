import { type NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { type Prisma } from '@prisma/client'

const STATUS_LABEL: Record<string, string> = {
  PLACED:      'En juego',
  WON:         'Ganada',
  LOST:        'Perdida',
  VOID:        'Anulada',
  CASHOUT:     'Cashout',
  PARTIAL_WIN: 'Parcial',
}

const SPORT_LABEL: Record<string, string> = {
  FOOTBALL:   'Fútbol',
  BASKETBALL: 'Baloncesto',
  TENNIS:     'Tenis',
  HOCKEY:     'Hockey',
  BASEBALL:   'Béisbol',
  RUGBY:      'Rugby',
  MMA:        'MMA',
  BOXING:     'Boxeo',
  MOTORSPORT: 'Motorsport',
  ESPORTS:    'eSports',
  OTHER:      'Otro',
}

const TYPE_LABEL: Record<string, string> = {
  ARBITRAGE: 'Surebet',
  MIDDLE:    'Middlebet',
  SINGLE:    'Single',
  COMBO:     'Combo',
  CASINO:    'Casino',
  CUSTOM:    'Custom',
}

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export async function GET(request: NextRequest) {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) return new NextResponse('Unauthorized', { status: 401 })

  const sp = request.nextUrl.searchParams
  const filterSport  = sp.get('sport')    ?? undefined
  const filterBm     = sp.get('bm')       ?? undefined
  const filterStatus = sp.get('status')   ?? undefined
  const filterLive   = sp.get('live')     ?? undefined
  const filterFrom   = sp.get('dateFrom') ?? undefined
  const filterTo     = sp.get('dateTo')   ?? undefined

  const where: Prisma.BetRecordWhereInput = {
    userId,
    deletedAt: null,
    ...(filterSport  ? { sport:  filterSport  as Prisma.EnumSportTypeNullableFilter['equals'] } : {}),
    ...(filterStatus ? { status: filterStatus as Prisma.EnumBetStatusFilter['equals'] } : {}),
    ...(filterLive === 'true'  ? { isLive: true  } : {}),
    ...(filterLive === 'false' ? { isLive: false } : {}),
    ...(filterBm ? {
      OR: [
        { primaryBookmakerId: filterBm },
        { legs: { some: { bookmakerId: filterBm } } },
      ],
    } : {}),
    ...(filterFrom || filterTo ? {
      datePlaced: {
        ...(filterFrom ? { gte: new Date(`${filterFrom}T00:00:00`) } : {}),
        ...(filterTo   ? { lte: new Date(`${filterTo}T23:59:59`)   } : {}),
      },
    } : {}),
  }

  const records = await prisma.betRecord.findMany({
    where,
    orderBy: { datePlaced: 'desc' },
    select: {
      datePlaced:       true,
      dateSettled:      true,
      type:             true,
      status:           true,
      sport:            true,
      isLive:           true,
      totalStake:       true,
      grossProfit:      true,
      potentialReturn:  true,
      title:            true,
      primaryBookmaker: { select: { name: true } },
      singleBetDetail:  { select: { selection: true, odds: true } },
      legs: {
        where:   { deletedAt: null },
        orderBy: { id: 'asc' },
        select:  { bookmaker: { select: { name: true } }, stake: true, odds: true },
      },
    },
  })

  const headers = [
    'Fecha', 'Hora', 'Tipo', 'Estado', 'Deporte', 'Momento',
    'Selección', 'Casa(s)', 'Cuota', 'Stake (€)', 'P&L (€)', 'Retorno potencial (€)',
  ]

  const rows = records.map((r) => {
    const dt        = new Date(r.datePlaced)
    const house     = r.legs.length > 0
      ? r.legs.map((l) => l.bookmaker.name).join(' + ')
      : (r.primaryBookmaker?.name ?? '')
    const cuota     = r.legs.length > 0
      ? r.legs.map((l) => parseFloat(l.odds.toString()).toFixed(2)).join(' / ')
      : (r.singleBetDetail?.odds ? parseFloat(r.singleBetDetail.odds.toString()).toFixed(2) : '')
    const profit    = r.grossProfit ? parseFloat(r.grossProfit.toString()).toFixed(2) : ''
    const potential = r.potentialReturn ? parseFloat(r.potentialReturn.toString()).toFixed(2) : ''
    const stake     = parseFloat(r.totalStake.toString()).toFixed(2)

    return [
      dt.toLocaleDateString('es-ES'),
      dt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
      TYPE_LABEL[r.type]   ?? r.type,
      STATUS_LABEL[r.status] ?? r.status,
      r.sport ? (SPORT_LABEL[r.sport] ?? r.sport) : '',
      r.isLive ? 'Live' : 'Pre-partido',
      r.title ?? r.singleBetDetail?.selection ?? '',
      house,
      cuota,
      stake,
      profit,
      potential,
    ].map(csvEscape).join(',')
  })

  const csv = [headers.map(csvEscape).join(','), ...rows].join('\r\n')

  // UTF-8 BOM para compatibilidad con Excel
  const body = '﻿' + csv
  const filename = `operaciones-${new Date().toISOString().slice(0, 10)}.csv`

  return new NextResponse(body, {
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
