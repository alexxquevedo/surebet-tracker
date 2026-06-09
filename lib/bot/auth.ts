import { timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'

/**
 * Verifica que la request viene de FidesBot usando el secreto compartido.
 * El bot envía: `x-bot-secret: {BOT_SECRET}`
 *
 * Usa timingSafeEqual para prevenir timing attacks.
 */
export function verifyBotSecret(request: NextRequest): boolean {
  const secret = process.env.BOT_SECRET ?? process.env.FIDESBOT_SECRET
  if (!secret) return false

  const provided = request.headers.get('x-bot-secret')?.trim()
  if (!provided) return false

  try {
    return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(secret, 'utf8'))
  } catch {
    // timingSafeEqual lanza si los buffers tienen longitudes distintas
    return false
  }
}
