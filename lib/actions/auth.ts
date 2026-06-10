'use server'
import bcrypt from 'bcryptjs'
import dns from 'dns/promises'
import { AuthError } from 'next-auth'
import { redirect } from 'next/navigation'
import { signIn } from '@/lib/auth/auth'
import { prisma } from '@/lib/db/client'
import { registerSchema } from '@/types/forms'
import { toActionError } from '@/lib/utils/errors'
import { sendWelcomeEmail } from '@/lib/services/email'

export type AuthActionState = { error: string } | null

export async function loginAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  try {
    await signIn('credentials', {
      email: formData.get('email') as string,
      password: formData.get('password') as string,
      redirectTo: '/dashboard',
    })
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.type === 'CredentialsSignin') {
        return { error: 'Email o contraseña incorrectos' }
      }
      return { error: 'Error al iniciar sesión. Inténtalo de nuevo.' }
    }
    throw error // Re-throw NEXT_REDIRECT so Next.js handles the redirect
  }
  return null
}

export async function registerAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const raw = {
    name: formData.get('name') as string,
    email: formData.get('email') as string,
    password: formData.get('password') as string,
    confirmPassword: formData.get('confirmPassword') as string,
  }

  const parsed = registerSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  // Verificar que el dominio del email tiene servidores de correo (MX)
  const emailDomain = parsed.data.email.split('@')[1]!
  try {
    const mxRecords = await dns.resolveMx(emailDomain)
    if (!mxRecords || mxRecords.length === 0) {
      return { error: 'El dominio del email no acepta correos. Comprueba que el email sea válido.' }
    }
  } catch (e: unknown) {
    const code = (e as { code?: string }).code
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ENONAME' || code === 'ESERVFAIL') {
      return { error: 'El dominio del email no existe. Usa un email válido.' }
    }
    // Timeout u otros errores transitorios: dejar pasar para evitar falsos positivos
  }

  // DB operations — separate try-catch so errors don't escape as redirects
  try {
    const existing = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    })
    if (existing) return { error: 'Este email ya está registrado' }

    const existingName = await prisma.user.findFirst({
      where: { name: { equals: parsed.data.name, mode: 'insensitive' } },
      select: { id: true },
    })
    if (existingName) return { error: 'Este nombre de usuario ya está en uso, elige otro' }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12)
    await prisma.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        passwordHash,
        plan: 'FREE',
        settings: {
          create: {
            primaryCurrency: 'EUR',
            roundStakesTo: 1,
          },
        },
      },
    })

    // Send welcome email (non-blocking — don't fail registration if email fails)
    void sendWelcomeEmail(parsed.data.email, parsed.data.name).catch(console.error)
  } catch (error) {
    return { error: toActionError(error).error }
  }

  // Redirigir al login con mensaje de éxito
  redirect('/login?registered=1')
}
