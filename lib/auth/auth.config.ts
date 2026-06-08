import type { NextAuthConfig } from 'next-auth'

/**
 * Configuración ligera de NextAuth — compatible con Edge Runtime.
 * NO importa bcryptjs ni Prisma. Solo se usa en middleware.ts.
 * La configuración completa (con providers y eventos) está en auth.ts.
 *
 * IMPORTANTE: sin session callback para que req.auth sea null
 * cuando no hay JWT válido (evita bucle de redirección).
 */
export const authConfig: NextAuthConfig = {
  session: { strategy: 'jwt', maxAge: 6 * 60 * 60 }, // 6 horas
  pages: {
    signIn: '/login',
    error: '/login',
  },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id   = user.id
        token.plan = (user as { plan?: string }).plan ?? 'FREE'
      }
      return token
    },
    session({ session, token }) {
      if (token?.id) {
        session.user.id   = token.id as string
        session.user.plan = (token.plan as string | undefined) ?? 'FREE'
      }
      return session
    },
  },
}
