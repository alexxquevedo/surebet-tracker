import { type NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { type Prisma } from '@prisma/client'
import ExcelJS from 'exceljs'
import { sendCsvExportEmail } from '@/lib/services/email'
import { fromZonedTime } from 'date-fns-tz'

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

// Formatea una fecha usando el timezone del usuario
function fmtDate(d: Date, tz: string) {
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz })
}
function fmtTime(d: Date, tz: string) {
  return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: tz })
}

// Nombre del archivo: "Operaciones Alex - 01/05/26 a 31/05/26" o "Operaciones Alex - Historial completo"
function buildFilename(username: string, from?: string, to?: string): string {
  const safe = (username || 'usuario').replace(/[^a-zA-Z0-9 áéíóúüñÁÉÍÓÚÜÑ\-_]/g, '')
  if (from && to) {
    const fmt = (s: string) => {
      const [y, m, d] = s.split('-')
      return `${d}/${m}/${(y ?? '').slice(2)}`
    }
    return `Operaciones ${safe} - ${fmt(from)} a ${fmt(to)}.xlsx`
  }
  if (from) {
    const [y, m, d] = from.split('-')
    return `Operaciones ${safe} - desde ${d}/${m}/${(y ?? '').slice(2)}.xlsx`
  }
  return `Operaciones ${safe} - Historial completo.xlsx`
}

export async function GET(request: NextRequest) {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) return new NextResponse('Unauthorized', { status: 401 })

  const sp           = request.nextUrl.searchParams
  const filterSport  = sp.get('sport')    ?? undefined
  const filterBm     = sp.get('bm')       ?? undefined
  const filterStatus = sp.get('status')   ?? undefined
  const filterLive   = sp.get('live')     ?? undefined
  const filterFrom        = sp.get('dateFrom') ?? undefined
  const filterTo          = sp.get('dateTo')   ?? undefined
  const filterCompetition = sp.get('comp')     ?? undefined

  // Datos del usuario (nombre + timezone)
  const userData = await prisma.user.findUnique({
    where:  { id: userId },
    select: { name: true, email: true, timezone: true },
  })
  const tz       = userData?.timezone ?? 'Europe/Madrid'
  const username = userData?.name ?? userData?.email?.split('@')[0] ?? 'usuario'

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
        ...(filterFrom ? { gte: fromZonedTime(`${filterFrom}T00:00:00`, tz) } : {}),
        ...(filterTo   ? { lte: fromZonedTime(`${filterTo}T23:59:59`,   tz) } : {}),
      },
    } : {}),
    ...(filterCompetition ? {
      OR: [
        { competition: filterCompetition },
        { comboDetail: { selections: { some: { competition: filterCompetition } } } },
      ],
    } : {}),
  }

  const records = await prisma.betRecord.findMany({
    where,
    orderBy: { datePlaced: 'desc' },
    select: {
      datePlaced:      true,
      eventDate:       true,
      type:            true,
      status:          true,
      sport:           true,
      competition:     true,
      eventName:       true,
      isLive:          true,
      totalStake:      true,
      grossProfit:     true,
      potentialReturn: true,
      title:           true,
      primaryBookmaker: { select: { name: true, etiqueta: true } },
      singleBetDetail:  { select: { selection: true, odds: true } },
      arbitrageDetail:  { select: { winningLegId: true } },
      middleDetail:     { select: { winningLegId: true, middleHit: true } },
      legs: {
        where:   { deletedAt: null },
        orderBy: { id: 'asc' },
        select:  { id: true, bookmaker: { select: { name: true, etiqueta: true } }, stake: true, odds: true },
      },
    },
  })

  // ── Construir Excel ───────────────────────────────────────────────────────

  const workbook  = new ExcelJS.Workbook()
  workbook.creator = 'DualStats Tracker'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('Operaciones', {
    views: [{ state: 'frozen', ySplit: 1 }],   // congela la fila de cabecera
  })

  // Columnas: nombre + ancho
  sheet.columns = [
    { header: 'Fecha reg.',          key: 'fecha',      width: 13 },
    { header: 'Hora reg.',           key: 'hora',       width: 8  },
    { header: 'Fecha evento',        key: 'fechaEvento',width: 13 },
    { header: 'Hora evento',         key: 'horaEvento', width: 12 },
    { header: 'Tipo',                key: 'tipo',       width: 12 },
    { header: 'Estado',              key: 'estado',     width: 11 },
    { header: 'Deporte',             key: 'deporte',    width: 13 },
    { header: 'Competición',         key: 'comp',       width: 22 },
    { header: 'Momento',             key: 'momento',    width: 12 },
    { header: 'Partido / Evento',    key: 'partido',    width: 28 },
    { header: 'Selección',           key: 'seleccion',  width: 36 },
    { header: 'Casa 1',              key: 'casa1',      width: 18 },
    { header: 'Casa 2',              key: 'casa2',      width: 18 },
    { header: 'Cuota 1',             key: 'cuota1',     width: 10 },
    { header: 'Cuota 2',             key: 'cuota2',     width: 10 },
    { header: 'Stake 1 (€)',         key: 'stake1',     width: 12 },
    { header: 'Stake 2 (€)',         key: 'stake2',     width: 12 },
    { header: 'P&L (€)',             key: 'pnl',          width: 11 },
    { header: 'Casa ganada',          key: 'casaGanada',   width: 18 },
    { header: 'Retorno potencial (€)', key: 'retorno',     width: 20 },
  ]

  // Estilo de cabecera
  const headerRow = sheet.getRow(1)
  headerRow.eachCell((cell) => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
    cell.border    = {
      top:    { style: 'thin', color: { argb: 'FF1E3A5F' } },
      left:   { style: 'thin', color: { argb: 'FF1E3A5F' } },
      bottom: { style: 'thin', color: { argb: 'FF1E3A5F' } },
      right:  { style: 'thin', color: { argb: 'FF1E3A5F' } },
    }
  })
  headerRow.height = 22

  // ── Helper: nombre con etiqueta opcional ────────────────────────────────
  function bmLabel(bm: { name: string; etiqueta?: string | null } | null | undefined): string {
    if (!bm) return ''
    return bm.etiqueta ? `${bm.name} · ${bm.etiqueta}` : bm.name
  }

  // ── Helper: bookmaker que "ganó" la operación ────────────────────────────
  function getCasaGanada(r: typeof records[number]): string {
    if (r.status === 'PLACED') return ''
    // ARBITRAGE: winningLegId apunta a la pierna que ganó
    if (r.type === 'ARBITRAGE' && r.arbitrageDetail?.winningLegId) {
      const leg = r.legs.find((l) => l.id === r.arbitrageDetail!.winningLegId)
      return leg ? bmLabel(leg.bookmaker) : ''
    }
    // MIDDLE: si middleHit ambas ganan; si no, la pierna indicada
    if (r.type === 'MIDDLE') {
      if (r.middleDetail?.middleHit === true) {
        return r.legs.map((l) => bmLabel(l.bookmaker)).join(' + ')
      }
      if (r.middleDetail?.winningLegId) {
        const leg = r.legs.find((l) => l.id === r.middleDetail!.winningLegId)
        return leg ? bmLabel(leg.bookmaker) : ''
      }
    }
    // SINGLE / COMBO / CASINO / CUSTOM: solo si ganó
    if (r.status === 'WON' || r.status === 'PARTIAL_WIN' || r.status === 'CASHOUT') {
      return bmLabel(r.primaryBookmaker)
    }
    return ''
  }

  // Filas de datos
  records.forEach((r, idx) => {
    const dt      = new Date(r.datePlaced)
    const dtEvt   = r.eventDate ? new Date(r.eventDate) : null
    const legs    = r.legs
    const isSingle = r.type === 'SINGLE' || legs.length <= 1

    const leg1 = legs[0]
    const leg2 = legs[1]

    const casa1  = bmLabel(leg1?.bookmaker) || bmLabel(r.primaryBookmaker)
    const casa2  = isSingle ? '' : (bmLabel(leg2?.bookmaker) || '')
    const cuota1 = leg1?.odds ? parseFloat(leg1.odds.toString()) : (r.singleBetDetail?.odds ? parseFloat(r.singleBetDetail.odds.toString()) : '')
    const cuota2 = isSingle ? '' : (leg2?.odds ? parseFloat(leg2.odds.toString()) : '')
    const stake1 = leg1?.stake ? parseFloat(leg1.stake.toString()) : (isSingle ? parseFloat(r.totalStake.toString()) : '')
    const stake2 = isSingle ? '' : (leg2?.stake ? parseFloat(leg2.stake.toString()) : '')
    const pnl    = r.grossProfit     ? parseFloat(r.grossProfit.toString())     : ''
    const ret    = r.potentialReturn ? parseFloat(r.potentialReturn.toString()) : ''
    const title  = r.title ?? r.singleBetDetail?.selection ?? ''

    const row = sheet.addRow({
      fecha:      fmtDate(dt, tz),
      hora:       fmtTime(dt, tz),
      fechaEvento: dtEvt ? fmtDate(dtEvt, tz) : '',
      horaEvento:  dtEvt ? fmtTime(dtEvt, tz) : '',
      tipo:     TYPE_LABEL[r.type]     ?? r.type,
      estado:   STATUS_LABEL[r.status] ?? r.status,
      deporte:  r.sport ? (SPORT_LABEL[r.sport] ?? r.sport) : '',
      comp:     r.competition ?? '',
      momento:  r.isLive ? 'Live' : 'Pre-partido',
      partido:   r.eventName ?? '',
      seleccion: title,
      casa1,
      casa2,
      cuota1,
      cuota2,
      stake1,
      stake2,
      pnl,
      casaGanada: getCasaGanada(r),
      retorno: ret,
    })

    // Fondo alternado claro
    const bgColor = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF5F7FA'

    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } }
      cell.border = {
        top:    { style: 'hair', color: { argb: 'FFCCCCCC' } },
        left:   { style: 'hair', color: { argb: 'FFCCCCCC' } },
        bottom: { style: 'hair', color: { argb: 'FFCCCCCC' } },
        right:  { style: 'hair', color: { argb: 'FFCCCCCC' } },
      }
      cell.alignment = { vertical: 'middle' }
    })

    row.height = 18
  })

  // Formato numérico para columnas de euros y cuotas
  const euroFmt = '#,##0.00 €'
  const oddsFmt = '0.00'
  ;['stake1', 'stake2', 'pnl', 'retorno'].forEach((key) => {
    const col = sheet.getColumn(key)
    col.numFmt = euroFmt
    col.alignment = { horizontal: 'right', vertical: 'middle' }
  })
  ;['cuota1', 'cuota2'].forEach((key) => {
    const col = sheet.getColumn(key)
    col.numFmt = oddsFmt
    col.alignment = { horizontal: 'center', vertical: 'middle' }
  })

  // ── Serializar y devolver ────────────────────────────────────────────────

  const buffer   = await workbook.xlsx.writeBuffer()
  const filename = buildFilename(username, filterFrom, filterTo)

  // Enviar email con el archivo adjunto (fire-and-forget — no bloquea la descarga)
  if (userData?.email) {
    void sendCsvExportEmail(userData.email, userData.name, filename, buffer).catch(console.error)
  }

  return new NextResponse(Buffer.from(buffer), {
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  })
}
