import type { NextAuthConfig } from 'next-auth'

/**
 * Configuración ligera de NextAuth — compatible con Edge Runtime.
 * NO importa bcryptjs ni Prisma. Solo se usa en middleware.ts.
 * La configuración completa (con providers y eventos) está en auth.ts.
 */
export const authConfig: NextAuthConfig = {
  session: { strategy: 'jwt' },
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
      if (token) {
        session.user.id   = token.id as string
        session.user.plan = token.plan as string
      }
      return session
    },
  },
}
