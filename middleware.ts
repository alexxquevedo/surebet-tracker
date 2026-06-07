import NextAuth from 'next-auth'
import { NextResponse } from 'next/server'
import { authConfig } from '@/lib/auth/auth.config'

// Instancia ligera — NO importa bcryptjs ni Prisma (Edge Runtime safe)
const { auth } = NextAuth(authConfig)

const PUBLIC_ROUTES = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/api/auth',
  '/api/health',
]

const AUTH_ROUTES = ['/login', '/register', '/forgot-password']

function isPublicRoute(pathname: string) {
  return PUBLIC_ROUTES.some((route) => pathname.startsWith(route))
}

function isAuthRoute(pathname: string) {
  return AUTH_ROUTES.some((route) => pathname.startsWith(route))
}

export default auth((req) => {
  const { pathname } = req.nextUrl

  // Static files y API de auth siempre pasan
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next()
  }

  // req.auth es null si no hay JWT válido, o Session si lo hay.
  // Comprobamos user.id para descartar objetos vacíos.
  const isAuthenticated = !!req.auth?.user?.id

  // Redirigir usuarios autenticados fuera de las páginas de auth
  if (isAuthenticated && isAuthRoute(pathname)) {
    return NextResponse.redirect(new URL('/dashboard', req.url))
  }

  // Bloquear rutas protegidas si no hay sesión
  if (!isAuthenticated && !isPublicRoute(pathname)) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // Headers de seguridad
  const response = NextResponse.next()
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')

  return response
})

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|public/).*)'],
}
