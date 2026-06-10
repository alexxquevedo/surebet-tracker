import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import ExcelJS from 'exceljs'

const PLAN_LABEL: Record<string, string> = {
  FREE:        'Free',
  PRO:         'Pro',
  PRO_TRACKER: 'Pro+Tracker',
  ENTERPRISE:  'Enterprise',
}

function fmtDate(d: Date | null) {
  if (!d) return ''
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid' })
}

export async function GET(req: NextRequest) {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) return new NextResponse('Unauthorized', { status: 401 })

  const dbUser = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } })
  if (!dbUser?.isAdmin) return new NextResponse('Forbidden', { status: 403 })

  const sp          = req.nextUrl.searchParams
  const filterPlan  = sp.get('plan') ?? undefined
  const filterFrom  = sp.get('from') ?? undefined
  const filterTo    = sp.get('to')   ?? undefined
  const filterTg    = sp.get('tg')   ?? undefined   // 'yes' | 'no'

  const users = await prisma.user.findMany({
    where: {
      ...(filterPlan ? { plan: filterPlan as never } : {}),
      ...(filterTg === 'yes' ? { telegramId: { not: null } } : {}),
      ...(filterTg === 'no'  ? { telegramId: null }          : {}),
      ...(filterFrom || filterTo ? {
        createdAt: {
          ...(filterFrom ? { gte: new Date(`${filterFrom}T00:00:00`) } : {}),
          ...(filterTo   ? { lte: new Date(`${filterTo}T23:59:59`)   } : {}),
        },
      } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, email: true,
      plan: true, planExpiresAt: true,
      isAdmin: true, hasEverPaid: true,
      telegramId: true, telegramUsername: true,
      createdAt: true, lastLoginAt: true,
      _count: { select: { betRecords: true } },
    },
  })

  const wb    = new ExcelJS.Workbook()
  wb.creator  = 'DualStats Tracker — Admin'
  wb.created  = new Date()

  const ws = wb.addWorksheet('Usuarios', { views: [{ state: 'frozen', ySplit: 1 }] })

  ws.columns = [
    { header: 'ID',             key: 'id',            width: 30 },
    { header: 'Nombre',         key: 'name',           width: 22 },
    { header: 'Email',          key: 'email',          width: 32 },
    { header: 'Plan',           key: 'plan',           width: 14 },
    { header: 'Expira',         key: 'expires',        width: 14 },
    { header: 'Ha pagado',      key: 'paid',           width: 11 },
    { header: 'Admin',          key: 'admin',          width: 8  },
    { header: 'Telegram',       key: 'telegram',       width: 16 },
    { header: 'TG Username',    key: 'tgUsername',     width: 18 },
    { header: 'Operaciones',    key: 'bets',           width: 13 },
    { header: 'Registrado',     key: 'createdAt',      width: 14 },
    { header: 'Último login',   key: 'lastLoginAt',    width: 14 },
  ]

  const headerRow = ws.getRow(1)
  headerRow.eachCell((cell) => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  headerRow.height = 20

  users.forEach((u, idx) => {
    const row = ws.addRow({
      id:          u.id,
      name:        u.name ?? '',
      email:       u.email ?? '',
      plan:        PLAN_LABEL[u.plan] ?? u.plan,
      expires:     fmtDate(u.planExpiresAt),
      paid:        u.hasEverPaid ? 'Sí' : 'No',
      admin:       u.isAdmin ? 'Sí' : 'No',
      telegram:    u.telegramId ? 'Sí' : 'No',
      tgUsername:  u.telegramUsername ?? '',
      bets:        u._count.betRecords,
      createdAt:   fmtDate(u.createdAt),
      lastLoginAt: fmtDate(u.lastLoginAt),
    })
    const bg = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF5F7FA'
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
      cell.border = {
        top:    { style: 'hair', color: { argb: 'FFCCCCCC' } },
        bottom: { style: 'hair', color: { argb: 'FFCCCCCC' } },
        left:   { style: 'hair', color: { argb: 'FFCCCCCC' } },
        right:  { style: 'hair', color: { argb: 'FFCCCCCC' } },
      }
      cell.alignment = { vertical: 'middle' }
    })
    row.height = 16
  })

  ws.getColumn('bets').alignment = { horizontal: 'center', vertical: 'middle' }

  const buffer   = await wb.xlsx.writeBuffer()
  const now      = new Date()
  const dateStr  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const filename = `Admin_Usuarios_${dateStr}.xlsx`

  return new NextResponse(Buffer.from(buffer), {
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  })
}
