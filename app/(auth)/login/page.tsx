import type { Metadata } from 'next'
import { LoginForm } from './_components/login-form'

export const metadata: Metadata = { title: 'Iniciar sesión' }

export default function LoginPage() {
  return (
    <div className="w-full max-w-sm">
      <div className="rounded-lg border bg-card p-8 shadow-sm">
        <div className="mb-6">
          <h2 className="text-xl font-semibold">Iniciar sesión</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Accede a tu cuenta de Surebet Tracker
          </p>
        </div>
        <LoginForm />
      </div>
    </div>
  )
}
