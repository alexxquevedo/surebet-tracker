/**
 * @deprecated Phase 1 legacy endpoint — pendiente de reescritura como /api/v1/records/[id]/settle
 *
 * Este endpoint será reemplazado por POST /api/v1/records/[id]/settle (Phase 2).
 * El modelo `Settlement` ya no existe en el schema v2.1.
 *
 * TODO (Phase 2): implementar POST /api/v1/records/[id]/settle
 */
import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json(
    {
      error: 'This endpoint has been deprecated. Use POST /api/v1/records/:id/settle instead.',
      code: 'ENDPOINT_DEPRECATED',
      migration: 'https://docs.surebettracker.pro/api/v2',
    },
    { status: 501 },
  )
}
