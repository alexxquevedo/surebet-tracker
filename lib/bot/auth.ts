import { timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'

/**
 * Verifica que la request viene de FidesBot usando el secreto compartido.
 * El bot envía: `Authorization: Bearer {FIDESBOT_SECRET}`
 *
 * Usa timingSafeEqual para prevenir timing attacks.
 */
export function verifyBotSecret(request: NextRequest): boolean {
  const secret = process.env.FIDESBOT_SECRET
  if (!secret) return false

  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return false

  const provided = authHeader.slice(7).trim()
  if (!provided) return false

  try {
    return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(secret, 'utf8'))
  } catch {
    // timingSafeEqual lanza si los buffers tienen longitudes distintas
    return false
  }
}
