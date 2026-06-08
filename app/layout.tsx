import type { Metadata, Viewport } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { Toaster } from 'sonner'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'DualStats Tracker',
    template: '%s | DualStats Tracker',
  },
  description:
    'La herramienta profesional de tracking para arbitraje deportivo. Controla tu bankroll, analiza tu ROI y optimiza tus operaciones.',
  keywords: ['arbitraje', 'surebet', 'apuestas deportivas', 'bankroll', 'ROI', 'tracker'],
  authors: [{ name: 'DualStats Tracker' }],
  creator: 'DualStats Tracker',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      {/* Aplica el tema ANTES de que React hidrate para evitar el flash blanco/negro */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('theme'),d=window.matchMedia('(prefers-color-scheme:dark)').matches;if(t==='dark'||(!t&&d))document.documentElement.classList.add('dark')}catch(e){}` }} />
      </head>
      <body className={`${GeistSans.variable} ${GeistMono.variable} font-sans`}>
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            duration: 4000,
            classNames: {
              toast: 'font-sans',
            },
          }}
        />
      </body>
    </html>
  )
}
