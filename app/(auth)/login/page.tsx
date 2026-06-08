import type { Metadata } from 'next'
import { LoginForm } from './_components/login-form'

export const metadata: Metadata = { title: 'Iniciar sesión' }

interface Props {
  searchParams: Promise<{ registered?: string }>
}

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams
  const justRegistered = params.registered === '1'

  return (
    <div className="w-full max-w-sm">
      <div className="rounded-lg border bg-card p-8 shadow-sm">
        <div className="mb-6">
          <h2 className="text-xl font-semibold">Iniciar sesión</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Accede a tu cuenta de Surebet Tracker
          </p>
        </div>
        {justRegistered && (
          <div className="mb-4 rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
            ¡Cuenta creada correctamente! Ya puedes iniciar sesión.
          </div>
        )}
        <LoginForm />
      </div>
    </div>
  )
}
