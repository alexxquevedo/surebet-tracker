'use server'

import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { revalidatePath } from 'next/cache'

export type BankrollActionResult =
  | { success: true; id: string }
  | { success: false; error: string }

// ════════════════════════════════════════════════════════════════════════════
// createBankrollAction
// ════════════════════════════════════════════════════════════════════════════

export async function createBankrollAction(formData: FormData): Promise<BankrollActionResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const name = (formData.get('name') as string | null)?.trim()
  const description = (formData.get('description') as string | null)?.trim() || undefined
  const color = (formData.get('color') as string | null) || '#6366f1'

  if (!name) return { success: false, error: 'El nombre del bankroll es obligatorio' }

  try {
    const bankroll = await prisma.bankroll.create({
      data: { userId, name, description, color, isDefault: false, isActive: true },
      select: { id: true },
    })
    revalidatePath('/bookmakers')
    revalidatePath('/dashboard')
    return { success: true, id: bankroll.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error al crear bankroll' }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// updateBankrollAction
// ════════════════════════════════════════════════════════════════════════════

export async function updateBankrollAction(
  id: string,
  formData: FormData,
): Promise<BankrollActionResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const name = (formData.get('name') as string | null)?.trim()
  const description = (formData.get('description') as string | null)?.trim() || undefined
  const color = (formData.get('color') as string | null) || '#6366f1'

  if (!name) return { success: false, error: 'El nombre es obligatorio' }

  try {
    const existing = await prisma.bankroll.findFirst({ where: { id, userId }, select: { id: true } })
    if (!existing) return { success: false, error: 'Bankroll no encontrado' }

    await prisma.bankroll.update({ where: { id }, data: { name, description, color } })
    revalidatePath('/bookmakers')
    revalidatePath('/dashboard')
    return { success: true, id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error al actualizar' }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// deleteBankrollAction
// ════════════════════════════════════════════════════════════════════════════

export async function deleteBankrollAction(id: string): Promise<BankrollActionResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  try {
    const existing = await prisma.bankroll.findFirst({
      where: { id, userId },
      select: { id: true, _count: { select: { bookmakers: true } } },
    })
    if (!existing) return { success: false, error: 'Bankroll no encontrado' }
    if (existing._count.bookmakers > 0) {
      return { success: false, error: 'No se puede eliminar: tiene casas asociadas. Reasígnalas primero.' }
    }

    await prisma.bankroll.delete({ where: { id } })
    revalidatePath('/bookmakers')
    revalidatePath('/dashboard')
    return { success: true, id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error al eliminar' }
  }
}
