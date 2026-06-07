import { createHash } from 'crypto'
import { prisma } from '@/lib/db/client'

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

export async function validateApiKey(
  rawKey: string,
): Promise<{ userId: string; keyId: string } | null> {
  if (!rawKey) return null

  const keyHash = hashApiKey(rawKey)

  const apiKey = await prisma.apiKey.findFirst({
    where: {
      keyHash,
      isRevoked: false,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true, userId: true },
  })

  if (!apiKey) return null

  void prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  })

  return { userId: apiKey.userId, keyId: apiKey.id }
}
