import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'

/**
 * POST /api/bot/users/sync
 *
 * El bot llama a este endpoint periódicamente (cada 30s) para persistir el estado
 * en memoria de los usuarios que han cambiado.
 *
 * Body: { users: Array<UserState> }
 *
 * UserState: {
 *   telegramId:    string
 *   telegramName?: string
 *   plan:          string        — "PRO" | "PRO_TRACKER"
 *   expiresAt:     string|null   — ISO string o null (permanente)
 *   config:        object|null   — per-user alert settings
 *   credits:       number
 *   referredUsers: string[]|null — telegram_ids de referidos
 *   referredBy:    string|null   — telegram_id de quien les refirió
 * }
 *
 * Usa upsert: crea el registro si no existe (usuarios activados manualmente por admin)
 * o actualiza todos los campos si ya existe. plan/expiresAt se actualizan siempre —
 * el webhook de Stripe es el que tiene la última palabra en caso de conflicto.
 */
export async function POST(request: NextRequest) {
  if (!verifyBotSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { users?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  if (!Array.isArray(body.users) || body.users.length === 0) {
    return NextResponse.json({ error: 'users debe ser un array no vacío' }, { status: 400 })
  }

  const users = body.users as Array<{
    telegramId:    string
    telegramName?: string | null
    plan:          string
    expiresAt:     string | null
    config:        Record<string, unknown> | null
    credits:       number
    referredUsers: string[] | null
    referredBy:    string | null
  }>

  let synced  = 0
  let errors  = 0

  for (const u of users) {
    if (!u.telegramId) continue
    const expiresAt = u.expiresAt ? new Date(u.expiresAt) : null

    try {
      await prisma.botSubscription.upsert({
        where:  { telegramId: u.telegramId },
        create: {
          telegramId:   u.telegramId,
          telegramName: u.telegramName ?? null,
          plan:         u.plan ?? 'PRO',
          expiresAt,
          config:       (u.config ?? undefined) as import('@prisma/client').Prisma.InputJsonValue | undefined,
          credits:      u.credits ?? 0,
          referredUsers: (u.referredUsers ?? undefined) as import('@prisma/client').Prisma.InputJsonValue | undefined,
          referredBy:   u.referredBy ?? null,
        },
        update: {
          telegramName:  u.telegramName ?? undefined,
          plan:          u.plan,
          expiresAt,
          config:        (u.config ?? undefined) as import('@prisma/client').Prisma.InputJsonValue | undefined,
          credits:       u.credits ?? 0,
          referredUsers: (u.referredUsers ?? undefined) as import('@prisma/client').Prisma.InputJsonValue | undefined,
          referredBy:    u.referredBy ?? null,
        },
      })
      synced++
    } catch (err) {
      console.error(`[bot/users/sync] Error upserting ${u.telegramId}:`, err)
      errors++
    }
  }

  return NextResponse.json({ ok: true, synced, errors })
}
