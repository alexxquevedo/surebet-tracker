'use server'

import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import { hashApiKey } from '@/lib/auth/api-key'
import { revalidatePath } from 'next/cache'

export type SettingsResult =
  | { success: true; message?: string }
  | { success: false; error: string }

export type ApiKeyResult =
  | { success: true; key: string; keyId: string }
  | { success: false; error: string }

// ── Profile ──────────────────────────────────────────────────────────────────

export async function updateProfileAction(formData: FormData): Promise<SettingsResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const name = (formData.get('name') as string | null)?.trim()
  if (!name) return { success: false, error: 'El nombre no puede estar vacío' }
  if (name.length > 60)
    return { success: false, error: 'El nombre es demasiado largo (máx. 60 caracteres)' }

  await prisma.user.update({ where: { id: userId }, data: { name } })
  revalidatePath('/settings')
  return { success: true, message: 'Nombre actualizado correctamente' }
}

// ── Password ──────────────────────────────────────────────────────────────────

export async function changePasswordAction(formData: FormData): Promise<SettingsResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const currentPw = formData.get('currentPassword') as string | null
  const newPw     = formData.get('newPassword')     as string | null
  const confirmPw = formData.get('confirmPassword') as string | null

  if (!currentPw || !newPw || !confirmPw)
    return { success: false, error: 'Todos los campos son obligatorios' }
  if (newPw.length < 8)
    return { success: false, error: 'La nueva contraseña debe tener al menos 8 caracteres' }
  if (newPw !== confirmPw)
    return { success: false, error: 'Las contraseñas no coinciden' }

  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { passwordHash: true },
  })
  if (!user?.passwordHash)
    return {
      success: false,
      error: 'Esta cuenta usa inicio de sesión con Google y no tiene contraseña local',
    }

  const isValid = await bcrypt.compare(currentPw, user.passwordHash)
  if (!isValid) return { success: false, error: 'La contraseña actual no es correcta' }

  const hash = await bcrypt.hash(newPw, 12)
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } })
  return { success: true, message: 'Contraseña actualizada correctamente' }
}

// ── Preferences ───────────────────────────────────────────────────────────────

export async function updatePreferencesAction(formData: FormData): Promise<SettingsResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const timezone = (formData.get('timezone') as string | null)?.trim() || 'Europe/Madrid'
  await prisma.user.update({ where: { id: userId }, data: { timezone } })
  revalidatePath('/settings')
  revalidatePath('/dashboard')
  return { success: true, message: 'Zona horaria guardada' }
}

// ── Notifications ─────────────────────────────────────────────────────────────

export async function updateNotificationPrefsAction(
  formData: FormData,
): Promise<SettingsResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const emailLoginAlert = formData.get('emailLoginAlert') === 'true'
  const emailOnSettle   = formData.get('emailOnSettle')   === 'true'

  await prisma.userSettings.upsert({
    where:  { userId },
    create: { userId, emailLoginAlert, emailOnSettle },
    update: { emailLoginAlert, emailOnSettle },
  })
  revalidatePath('/settings')
  return { success: true, message: 'Preferencias de notificación guardadas' }
}

// ── Delete account ────────────────────────────────────────────────────────────

export async function deleteAccountAction(formData: FormData): Promise<SettingsResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const confirmation = (formData.get('confirmation') as string | null)?.trim()
  if (confirmation !== 'ELIMINAR')
    return { success: false, error: 'Debes escribir exactamente "ELIMINAR" para confirmar' }

  // Cascade deletes all related data via onDelete: Cascade in Prisma schema
  await prisma.user.delete({ where: { id: userId } })
  return { success: true }
}

// ── API Keys ──────────────────────────────────────────────────────────────────

export async function generateApiKeyAction(formData: FormData): Promise<ApiKeyResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const name = (formData.get('name') as string | null)?.trim()
  if (!name) return { success: false, error: 'El nombre de la clave es obligatorio' }

  const count = await prisma.apiKey.count({ where: { userId, isRevoked: false } })
  if (count >= 5) return { success: false, error: 'Límite de 5 claves activas alcanzado' }

  // Format: sbt_live_<48 hex chars>  →  57 chars total
  const rawKey    = `sbt_live_${randomBytes(24).toString('hex')}`
  const keyHash   = hashApiKey(rawKey)
  const keyPrefix = rawKey.slice(0, 16) // "sbt_live_xxxxxxx"

  const created = await prisma.apiKey.create({
    data: {
      userId,
      name,
      keyHash,
      keyPrefix,
      permissions: ['records:read', 'bookmakers:read'],
    },
    select: { id: true },
  })

  revalidatePath('/settings')
  return { success: true, key: rawKey, keyId: created.id }
}

export async function revokeApiKeyAction(keyId: string): Promise<SettingsResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const key = await prisma.apiKey.findFirst({
    where:  { id: keyId, userId },
    select: { id: true },
  })
  if (!key) return { success: false, error: 'Clave no encontrada' }

  await prisma.apiKey.update({ where: { id: keyId }, data: { isRevoked: true } })
  revalidatePath('/settings')
  return { success: true }
}
