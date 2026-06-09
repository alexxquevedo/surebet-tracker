import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'

/**
 * POST /api/bot/connect
 *
 * FidesBot llama a este endpoint cuando el usuario pulsa el deep link de vinculación.
 * Valida el token (existe, no expiró, no usado) y vincula el telegram_id con el userId.
 *
 * Body: { telegram_id: number, telegram_username: string, token: string }
 *
 * Respuestas:
 *   200 { success: true, userId }
 *   400 Faltan campos
 *   401 Secreto inválido
 *   404 TOKEN_NOT_FOUND
 *   409 TOKEN_USED
 *   410 TOKEN_EXPIRED
 */
export async function POST(request: NextRequest) {
  if (!verifyBotSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { telegram_id?: unknown; telegram_username?: unknown; token?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { telegram_id, telegram_username, token } = body

  if (!telegram_id || !token || typeof token !== 'string') {
    return NextResponse.json(
      { error: 'telegram_id and token are required' },
      { status: 400 },
    )
  }

  const telegramIdStr = String(telegram_id)

  // ── Buscar el token ──────────────────────────────────────
  const linkToken = await prisma.linkToken.findUnique({
    where:   { token: token as string },
    include: { user: { select: { id: true, plan: true } } },
  })

  if (!linkToken) {
    return NextResponse.json(
      { error: 'TOKEN_NOT_FOUND', message: 'Token no encontrado. Genera uno nuevo en DualStats.' },
      { status: 404 },
    )
  }
  if (linkToken.usedAt) {
    return NextResponse.json(
      { error: 'TOKEN_USED', message: 'Este enlace ya ha sido utilizado.' },
      { status: 409 },
    )
  }
  if (linkToken.expiresAt < new Date()) {
    return NextResponse.json(
      { error: 'TOKEN_EXPIRED', message: 'El enlace ha caducado. Genera uno nuevo en Configuración → Integraciones.' },
      { status: 410 },
    )
  }

  // ── Si este telegram_id ya estaba vinculado a otra cuenta, desvincular ──
  const previousUser = await prisma.user.findUnique({
    where:  { telegramId: telegramIdStr },
    select: { id: true },
  })
  if (previousUser && previousUser.id !== linkToken.userId) {
    await prisma.user.update({
      where: { id: previousUser.id },
      data:  { telegramId: null, telegramUsername: null },
    })
    // Marcar integración anterior como REVOKED
    await prisma.userIntegration.updateMany({
      where: { userId: previousUser.id, type: 'TELEGRAM' },
      data:  { status: 'REVOKED' },
    })
  }

  const usernameStr = telegram_username
    ? String(telegram_username).replace(/^@/, '')
    : null

  // ── Vincular en una transacción atómica ──────────────────
  await prisma.$transaction([
    // Guardar telegram_id en el usuario
    prisma.user.update({
      where: { id: linkToken.userId },
      data:  { telegramId: telegramIdStr, telegramUsername: usernameStr },
    }),
    // Marcar token como usado
    prisma.linkToken.update({
      where: { id: linkToken.id },
      data:  { usedAt: new Date() },
    }),
    // Upsert integración TELEGRAM (registro de estado)
    prisma.userIntegration.upsert({
      where:  { userId_type: { userId: linkToken.userId, type: 'TELEGRAM' } },
      create: {
        userId:    linkToken.userId,
        type:      'TELEGRAM',
        status:    'ACTIVE',
        externalId: telegramIdStr,
        name:       usernameStr ? `@${usernameStr}` : `ID:${telegramIdStr}`,
        lastUsedAt: new Date(),
      },
      update: {
        status:    'ACTIVE',
        externalId: telegramIdStr,
        name:       usernameStr ? `@${usernameStr}` : `ID:${telegramIdStr}`,
        lastUsedAt: new Date(),
        errorCount: 0,
        lastError:  null,
      },
    }),
  ])

  // ── Si el usuario tiene PRO_TRACKER en la web → activar BotSubscription ──
  const fullUser = await prisma.user.findUnique({
    where:  { id: linkToken.userId },
    select: { plan: true, planExpiresAt: true },
  })

  if (
    fullUser &&
    (fullUser.plan === 'PRO_TRACKER' || fullUser.plan === 'ENTERPRISE') &&
    fullUser.planExpiresAt &&
    fullUser.planExpiresAt > new Date()
  ) {
    await prisma.botSubscription.upsert({
      where:  { telegramId: telegramIdStr },
      create: { telegramId: telegramIdStr, plan: fullUser.plan, expiresAt: fullUser.planExpiresAt },
      update: { plan: fullUser.plan, expiresAt: fullUser.planExpiresAt },
    })
  }

  return NextResponse.json({
    success:       true,
    userId:        linkToken.userId,
    plan:          fullUser?.plan ?? linkToken.user.plan,
    planExpiresAt: fullUser?.planExpiresAt?.toISOString() ?? null,
  })
}
