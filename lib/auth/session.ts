import { auth } from './auth'
import { AppError, ErrorCodes } from '@/lib/utils/errors'

export async function getSession() {
  return auth()
}

export async function getCurrentUser() {
  const session = await auth()
  if (!session?.user?.id) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, 'No autenticado', 401)
  }
  return session.user
}

export async function getCurrentUserId(): Promise<string> {
  const user = await getCurrentUser()
  return user.id
}
