import NextAuth from 'next-auth'
import { PrismaAdapter } from '@auth/prisma-adapter'
import Google from 'next-auth/providers/google'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '@/lib/db/client'
import { sendLoginNotificationEmail } from '@/lib/services/email'

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
    error: '/login',
    verifyRequest: '/verify-email',
  },
  providers: [
    // Google solo se activa si las variables de entorno están configuradas
    ...(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
      ? [
          Google({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
          }),
        ]
      : []),
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        try {
          const parsed = credentialsSchema.safeParse(credentials)
          if (!parsed.success) return null

          const user = await prisma.user.findUnique({
            where: { email: parsed.data.email },
            select: {
              id: true,
              email: true,
              name: true,
              image: true,
              passwordHash: true,
              plan: true,
            },
          })

          if (!user?.passwordHash) return null

          const isValid = await bcrypt.compare(parsed.data.password, user.passwordHash)
          if (!isValid) return null

          // Fire-and-forget — no bloqueamos el login si falla esta actualización secundaria
          prisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
          }).catch((err: unknown) => console.error('[Auth] lastLoginAt update failed:', err))

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            image: user.image,
            plan: user.plan,
          }
        } catch (error) {
          console.error('[Auth] authorize error:', error)
          return null
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id
        token.plan = (user as { plan?: string }).plan ?? 'FREE'
      }
      if (trigger === 'update' && session?.plan) {
        token.plan = session.plan
      }
      return token
    },
    async session({ session, token }) {
      if (token) {
        session.user.id = token.id as string
        session.user.plan = token.plan as string
      }
      return session
    },
  },
  events: {
    async signIn({ user, isNewUser }) {
      try {
        if (isNewUser && user.id) {
          await prisma.userSettings.upsert({
            where:  { userId: user.id },
            update: {},
            create: { userId: user.id },
          })
        }
        // Send login security notification only if the user has it enabled (default: true)
        if (user.email && !isNewUser && user.id) {
          const prefs = await prisma.userSettings.findUnique({
            where:  { userId: user.id },
            select: { emailLoginAlert: true },
          })
          if (prefs?.emailLoginAlert !== false) {
            void sendLoginNotificationEmail(user.email, user.name ?? null).catch(console.error)
          }
        }
      } catch (error) {
        console.error('[Auth] signIn event error:', error)
        // No relanzamos — el login debe funcionar aunque fallen operaciones secundarias
      }
    },
  },
})
