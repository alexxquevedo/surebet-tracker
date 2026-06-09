'use server'

import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { revalidatePath } from 'next/cache'

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface AdminUser {
  id:           string
  name:         string | null
  email:        string | null
  plan:         string
  planExpiresAt: string | null   // ISO string
  daysLeft:     number | null    // null si FREE o sin fecha
  isAdmin:      boolean
  telegramLinked: boolean
  betCount:     number
  createdAt:    string
  lastLoginAt:  string | null
}

export interface AdminStats {
  totalUsers:  number
  proUsers:    number
  freeUsers:   number
  adminUsers:  number
  totalBets:   number
  newThisWeek: number
  newThisMonth: number
}

export type AdminActionResult =
  | { success: true; message: string }
  | { success: false; error: string }

// ── Guard: solo admins ────────────────────────────────────────────────────────

async function requireAdmin(): Promise<string | null> {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) return null
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } })
  return u?.isAdmin ? userId : null
}

// ── Datos del panel ───────────────────────────────────────────────────────────

export async function getAdminDataAction(): Promise<
  | { success: true; stats: AdminStats; users: AdminUser[] }
  | { success: false; error: string }
> {
  const adminId = await requireAdmin()
  if (!adminId) return { success: false, error: 'No autorizado' }

  const now = new Date()

  const [users, totalBets, newThisWeek, newThisMonth] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, email: true,
        plan: true, planExpiresAt: true, isAdmin: true,
        telegramId: true, createdAt: true, lastLoginAt: true,
        _count: { select: { betRecords: true } },
      },
    }),
    prisma.betRecord.count({ where: { deletedAt: null } }),
    prisma.user.count({
      where: { createdAt: { gte: new Date(now.getTime() - 7 * 24 * 3600 * 1000) } },
    }),
    prisma.user.count({
      where: { createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) } },
    }),
  ])

  const adminUsers: AdminUser[] = users.map((u) => {
    let daysLeft: number | null = null
    if (u.planExpiresAt) {
      const diff = u.planExpiresAt.getTime() - now.getTime()
      daysLeft = Math.max(0, Math.ceil(diff / (1000 * 3600 * 24)))
    }
    return {
      id:             u.id,
      name:           u.name,
      email:          u.email,
      plan:           u.plan,
      planExpiresAt:  u.planExpiresAt?.toISOString() ?? null,
      daysLeft,
      isAdmin:        u.isAdmin,
      telegramLinked: !!u.telegramId,
      betCount:       u._count.betRecords,
      createdAt:      u.createdAt.toISOString(),
      lastLoginAt:    u.lastLoginAt?.toISOString() ?? null,
    }
  })

  const stats: AdminStats = {
    totalUsers:   users.length,
    proUsers:     users.filter((u) => u.plan === 'PRO' || u.plan === 'ENTERPRISE').length,
    freeUsers:    users.filter((u) => u.plan === 'FREE').length,
    adminUsers:   users.filter((u) => u.isAdmin).length,
    totalBets,
    newThisWeek,
    newThisMonth,
  }

  return { success: true, stats, users: adminUsers }
}

// ── Activar PRO ───────────────────────────────────────────────────────────────

export async function activateProAction(
  targetUserId: string,
  days: number = 30,
): Promise<AdminActionResult> {
  const adminId = await requireAdmin()
  if (!adminId) return { success: false, error: 'No autorizado' }
  if (days < 1 || days > 365) return { success: false, error: 'Días inválidos (1-365)' }

  const target = await prisma.user.findUnique({
    where:  { id: targetUserId },
    select: { plan: true, planExpiresAt: true, email: true },
  })
  if (!target) return { success: false, error: 'Usuario no encontrado' }

  // Si ya tiene PRO activo, extender desde la fecha actual de expiración
  const base = (target.plan === 'PRO' && target.planExpiresAt && target.planExpiresAt > new Date())
    ? target.planExpiresAt
    : new Date()
  const expiresAt = new Date(base.getTime() + days * 24 * 3600 * 1000)

  await prisma.user.update({
    where: { id: targetUserId },
    data:  { plan: 'PRO', planExpiresAt: expiresAt },
  })

  revalidatePath('/settings')
  return { success: true, message: `PRO activado hasta ${expiresAt.toLocaleDateString('es-ES')} (+${days}d)` }
}

// ── Revocar PRO ───────────────────────────────────────────────────────────────

export async function revokeProAction(targetUserId: string): Promise<AdminActionResult> {
  const adminId = await requireAdmin()
  if (!adminId) return { success: false, error: 'No autorizado' }

  await prisma.user.update({
    where: { id: targetUserId },
    data:  { plan: 'FREE', planExpiresAt: null },
  })

  revalidatePath('/settings')
  return { success: true, message: 'Plan revertido a FREE.' }
}

// ── Hacer/quitar admin ────────────────────────────────────────────────────────

export async function toggleAdminAction(
  targetUserId: string,
  makeAdmin: boolean,
): Promise<AdminActionResult> {
  const adminId = await requireAdmin()
  if (!adminId) return { success: false, error: 'No autorizado' }
  if (targetUserId === adminId) return { success: false, error: 'No puedes modificar tu propio rol' }

  await prisma.user.update({
    where: { id: targetUserId },
    data:  { isAdmin: makeAdmin },
  })

  revalidatePath('/settings')
  return { success: true, message: makeAdmin ? 'Usuario promovido a admin.' : 'Admin revocado.' }
}
