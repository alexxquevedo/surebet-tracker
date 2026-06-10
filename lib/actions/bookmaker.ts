'use server'

import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import Decimal from 'decimal.js'
import { revalidatePath } from 'next/cache'
import type { BookmakerPreset } from '@/lib/utils/bookmakers-preset'

export type BookmakerActionResult =
  | { success: true; id: string }
  | { success: false; error: string }

function D(v: unknown): Decimal {
  return new Decimal(String(v ?? 0))
}

// ════════════════════════════════════════════════════════════════════════════
// addPresetBookmakerAction
// Crea una nueva casa de apuestas para el usuario a partir de un preset.
// ════════════════════════════════════════════════════════════════════════════

const FREE_BOOKMAKER_LIMIT = 3

export async function addPresetBookmakerAction(
  preset: BookmakerPreset,
  initialBalance: number,
  etiqueta?: string,
): Promise<BookmakerActionResult> {
  const session = await auth()
  const userId  = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  if (isNaN(initialBalance) || initialBalance < 0) {
    return { success: false, error: 'Saldo inicial inválido (debe ser ≥ 0)' }
  }

  // Normalise etiqueta: empty string treated as no label
  const etiquetaVal = etiqueta?.trim() ?? ''

  // FREE plan: max 3 active bookmakers
  const userPlan = (session?.user as { plan?: string })?.plan ?? 'FREE'
  if (userPlan === 'FREE') {
    const activeCount = await prisma.bookmaker.count({ where: { userId, status: 'ACTIVE' } })
    if (activeCount >= FREE_BOOKMAKER_LIMIT)
      return { success: false, error: `Plan FREE: límite de ${FREE_BOOKMAKER_LIMIT} casas activas alcanzado. Actualiza a PRO para casas ilimitadas.` }
  }

  try {
    // Same [name + etiqueta] combination must be unique per user
    const existing = await prisma.bookmaker.findFirst({
      where: { userId, name: preset.name, etiqueta: etiquetaVal },
      select: { id: true },
    })
    if (existing) {
      const label = etiquetaVal ? `${preset.name} · ${etiquetaVal}` : preset.name
      return { success: false, error: `${label} ya existe en tu cuenta` }
    }

    const bm = await prisma.$transaction(async (tx) => {
      const created = await tx.bookmaker.create({
        data: {
          userId,
          name:        preset.name,
          etiqueta:    etiquetaVal,
          color:       preset.color,
          currency:    preset.currency,
          country:     preset.country,
          websiteUrl:  preset.websiteUrl,
          status:      'ACTIVE',
          currentBalance: initialBalance,
        },
        select: { id: true },
      })

      // Record initial deposit transaction if balance > 0
      if (initialBalance > 0) {
        await tx.bookmakerTransaction.create({
          data: {
            userId,
            bookmakerId:   created.id,
            type:          'INITIAL_DEPOSIT',
            amount:        initialBalance,
            balanceBefore: 0,
            balanceAfter:  initialBalance,
            currency:      preset.currency,
            notes:         'Saldo inicial al añadir casa',
          },
        })
      }

      return created
    })

    return { success: true, id: bm.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error al crear la casa de apuestas'
    return { success: false, error: msg }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// editBookmakerAction — editar nombre y/o notas de una casa
// ════════════════════════════════════════════════════════════════════════════

export async function editBookmakerAction(formData: FormData): Promise<BookmakerActionResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const id   = (formData.get('id') as string | null)?.trim()
  const name = (formData.get('name') as string | null)?.trim()
  const notes = (formData.get('notes') as string | null)?.trim() || undefined

  if (!id) return { success: false, error: 'ID requerido' }
  if (!name) return { success: false, error: 'El nombre es obligatorio' }

  try {
    const existing = await prisma.bookmaker.findFirst({
      where: { id, userId },
      select: { id: true },
    })
    if (!existing) return { success: false, error: 'Casa no encontrada' }

    await prisma.bookmaker.update({ where: { id }, data: { name, notes } })
    revalidatePath('/bookmakers')
    return { success: true, id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error al editar' }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// toggleBookmakerStatusAction — ACTIVE ↔ SUSPENDED
// ════════════════════════════════════════════════════════════════════════════

export async function toggleBookmakerStatusAction(formData: FormData): Promise<BookmakerActionResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const id = (formData.get('id') as string | null)?.trim()
  if (!id) return { success: false, error: 'ID requerido' }

  try {
    const bm = await prisma.bookmaker.findFirst({
      where: { id, userId },
      select: { id: true, status: true },
    })
    if (!bm) return { success: false, error: 'Casa no encontrada' }

    const newStatus = bm.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED'
    await prisma.bookmaker.update({ where: { id }, data: { status: newStatus } })
    revalidatePath('/bookmakers')
    return { success: true, id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error al cambiar estado' }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// adjustBookmakerBalanceAction — ajuste manual con log de auditoría
// ════════════════════════════════════════════════════════════════════════════

export async function adjustBookmakerBalanceAction(formData: FormData): Promise<BookmakerActionResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  const id        = (formData.get('id') as string | null)?.trim()
  const rawAmount = formData.get('amount') as string | null
  const direction = formData.get('direction') as string | null  // 'deposit' | 'withdrawal'
  const notes     = (formData.get('notes') as string | null)?.trim() || 'Ajuste manual de saldo'

  if (!id) return { success: false, error: 'ID requerido' }
  const amount = parseFloat(rawAmount ?? '')
  if (isNaN(amount) || amount <= 0) return { success: false, error: 'Importe inválido (debe ser > 0)' }
  if (direction !== 'deposit' && direction !== 'withdrawal') {
    return { success: false, error: 'Dirección inválida' }
  }

  const signedAmount = direction === 'deposit' ? D(amount) : D(amount).neg()

  try {
    await prisma.$transaction(async (tx) => {
      const bm = await tx.bookmaker.findFirst({
        where: { id, userId },
        select: { id: true, currentBalance: true },
      })
      if (!bm) throw new Error('Casa no encontrada')

      const balBefore = D(bm.currentBalance)
      const balAfter  = balBefore.plus(signedAmount).toDecimalPlaces(2)

      await tx.bookmaker.update({
        where: { id },
        data: { currentBalance: balAfter },
      })

      await tx.bookmakerTransaction.create({
        data: {
          userId,
          bookmakerId:   id,
          type:          'MANUAL_ADJUSTMENT',
          amount:        signedAmount.abs(),
          balanceBefore: balBefore,
          balanceAfter:  balAfter,
          notes:         `${direction === 'deposit' ? '↑' : '↓'} ${notes}`,
          referenceType: 'ManualAdjustment',
        },
      })
    })

    revalidatePath('/bookmakers')
    return { success: true, id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error al ajustar saldo' }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// assignBankrollAction — vincular/desvincular una casa de un bankroll
// ════════════════════════════════════════════════════════════════════════════

export async function assignBankrollAction(
  bookmakerId: string,
  bankrollId: string | null,
): Promise<BookmakerActionResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { success: false, error: 'No autenticado' }

  try {
    const bm = await prisma.bookmaker.findFirst({
      where: { id: bookmakerId, userId },
      select: { id: true },
    })
    if (!bm) return { success: false, error: 'Casa no encontrada' }

    await prisma.bookmaker.update({
      where: { id: bookmakerId },
      data: { bankrollId: bankrollId ?? null },
    })
    revalidatePath('/bookmakers')
    return { success: true, id: bookmakerId }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error al asignar bankroll' }
  }
}
