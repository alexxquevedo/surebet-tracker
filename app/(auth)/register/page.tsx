import type { Metadata } from 'next'
import { RegisterForm } from './_components/register-form'

export const metadata: Metadata = { title: 'Crear cuenta' }

export default function RegisterPage() {
  return (
    <div className="w-full max-w-sm">
      <div className="rounded-lg border bg-card p-8 shadow-sm">
        <div className="mb-6">
          <h2 className="text-xl font-semibold">Crear cuenta</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Empieza a trackear tus arbitrajes gratis
          </p>
        </div>
        <RegisterForm />
      </div>
    </div>
  )
}
