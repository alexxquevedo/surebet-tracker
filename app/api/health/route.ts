import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'

export async function GET() {
  const status = {
    status: 'ok' as 'ok' | 'degraded' | 'down',
    timestamp: new Date().toISOString(),
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0',
    services: {
      database: 'ok' as 'ok' | 'error',
    },
  }

  try {
    await prisma.$queryRaw`SELECT 1`
  } catch {
    status.services.database = 'error'
    status.status = 'degraded'
  }

  const httpStatus = status.status === 'down' ? 503 : 200
  return NextResponse.json(status, { status: httpStatus })
}
