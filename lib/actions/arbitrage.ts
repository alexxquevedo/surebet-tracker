'use server'
/**
 * @deprecated Phase 1 legacy — pendiente de reescritura como lib/actions/bet-record.ts
 *
 * Este archivo ha sido vaciado tras el pivot arquitectónico a v2.1.
 * El modelo `Arbitrage` y `Settlement` ya no existen en el schema.
 * Las nuevas acciones operan sobre `BetRecord` con tipo ARBITRAGE.
 *
 * TODO (Phase 2):
 *  - Crear lib/actions/bet-record.ts con createBetRecordAction()
 *  - Crear lib/actions/settle.ts con settleBetRecordAction()
 *  - Eliminar este archivo
 */

export type ActionResult = { success: true; id?: string } | { success: false; error: string }

export async function createArbitrageAction(_formData: unknown): Promise<ActionResult> {
  return { success: false, error: 'Not implemented — use the new BetRecord API (Phase 2)' }
}

export async function settleArbitrageAction(
  _betRecordId: string,
  _formData: unknown,
): Promise<ActionResult> {
  return { success: false, error: 'Not implemented — use the new BetRecord API (Phase 2)' }
}

export async function voidArbitrageAction(
  _betRecordId: string,
  _notes?: string,
): Promise<ActionResult> {
  return { success: false, error: 'Not implemented — use the new BetRecord API (Phase 2)' }
}
