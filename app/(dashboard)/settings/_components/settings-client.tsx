'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import {
  updateProfileAction,
  changePasswordAction,
  updatePreferencesAction,
  updateNotificationPrefsAction,
  deleteAccountAction,
  generateApiKeyAction,
  revokeApiKeyAction,
} from '@/lib/actions/settings'
import type { SettingsResult } from '@/lib/actions/settings'

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = 'perfil' | 'preferencias' | 'notificaciones' | 'api-keys' | 'peligro'

interface ApiKeyData {
  id: string
  name: string
  keyPrefix: string
  lastUsedAt: string | null
  createdAt: string
}

export interface SettingsClientProps {
  user: {
    name: string | null
    email: string | null
    plan: string
    timezone: string
    hasPassword: boolean
  }
  settings: {
    emailLoginAlert: boolean
    emailOnSettle: boolean
  }
  apiKeys: ApiKeyData[]
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusMessage({ result, onDismiss }: { result: SettingsResult; onDismiss: () => void }) {
  const isOk = result.success
  const text = isOk
    ? ((result as { success: true; message?: string }).message ?? 'Guardado correctamente')
    : (result as { success: false; error: string }).error
  return (
    <div
      className={`flex items-center gap-2 text-sm px-3 py-2 rounded-md border ${
        isOk
          ? 'bg-green-50 text-green-800 border-green-200'
          : 'bg-red-50 text-red-800 border-red-200'
      }`}
    >
      <span className="shrink-0">{isOk ? '✓' : '✗'}</span>
      <span className="flex-1">{text}</span>
      <button onClick={onDismiss} className="shrink-0 text-xs opacity-60 hover:opacity-100 leading-none">
        ×
      </button>
    </div>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 ${
        value ? 'bg-primary' : 'bg-muted-foreground/30'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          value ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

function InputField({
  label,
  type = 'text',
  value,
  onChange,
  placeholder,
  autoComplete,
  maxLength,
}: {
  label: string
  type?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  maxLength?: number
}) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        maxLength={maxLength}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
      />
    </div>
  )
}

const TIMEZONES = [
  'Europe/Madrid',
  'Europe/London',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Brussels',
  'Europe/Warsaw',
  'Europe/Bucharest',
  'Europe/Moscow',
  'Europe/Istanbul',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Bogota',
  'America/Lima',
  'America/Buenos_Aires',
  'America/Sao_Paulo',
  'America/Caracas',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
]

// ── Main component ────────────────────────────────────────────────────────────

export function SettingsClient({ user, settings, apiKeys }: SettingsClientProps) {
  const router   = useRouter()
  const [isPending, startTransition] = useTransition()
  const [activeTab, setActiveTab]    = useState<Tab>('perfil')
  const [toast, setToast]            = useState<SettingsResult | null>(null)

  // Profile
  const [name, setName] = useState(user.name ?? '')

  // Password
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw]         = useState('')
  const [confirmPw, setConfirmPw] = useState('')

  // Preferences
  const [timezone, setTimezone] = useState(user.timezone)

  // Notifications
  const [emailLoginAlert, setEmailLoginAlert] = useState(settings.emailLoginAlert)
  const [emailOnSettle, setEmailOnSettle]     = useState(settings.emailOnSettle)

  // API keys — track revoked locally for optimistic UI
  const [revokedIds, setRevokedIds]       = useState<Set<string>>(new Set())
  const [newKeyName, setNewKeyName]       = useState('')
  const [generatedKey, setGeneratedKey]   = useState<string | null>(null)
  const [copiedKey, setCopiedKey]         = useState(false)
  const visibleKeys = apiKeys.filter((k) => !revokedIds.has(k.id))

  // Danger zone
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // ── Helpers ──────────────────────────────────────────────────────────────

  function showToast(r: SettingsResult) {
    setToast(r)
    if (r.success) setTimeout(() => setToast(null), 4000)
  }

  function copyKey() {
    if (!generatedKey) return
    void navigator.clipboard.writeText(generatedKey)
    setCopiedKey(true)
    setTimeout(() => setCopiedKey(false), 2000)
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  function handleUpdateProfile() {
    const fd = new FormData()
    fd.set('name', name)
    startTransition(async () => {
      const r = await updateProfileAction(fd)
      showToast(r)
      if (r.success) router.refresh()
    })
  }

  function handleChangePassword() {
    const fd = new FormData()
    fd.set('currentPassword', currentPw)
    fd.set('newPassword', newPw)
    fd.set('confirmPassword', confirmPw)
    startTransition(async () => {
      const r = await changePasswordAction(fd)
      showToast(r)
      if (r.success) { setCurrentPw(''); setNewPw(''); setConfirmPw('') }
    })
  }

  function handleUpdatePreferences() {
    const fd = new FormData()
    fd.set('timezone', timezone)
    startTransition(async () => {
      const r = await updatePreferencesAction(fd)
      showToast(r)
    })
  }

  function handleUpdateNotifications() {
    const fd = new FormData()
    fd.set('emailLoginAlert', String(emailLoginAlert))
    fd.set('emailOnSettle', String(emailOnSettle))
    startTransition(async () => {
      const r = await updateNotificationPrefsAction(fd)
      showToast(r)
    })
  }

  function handleGenerateKey() {
    const fd = new FormData()
    fd.set('name', newKeyName)
    startTransition(async () => {
      const r = await generateApiKeyAction(fd)
      if (!r.success) { showToast(r); return }
      setGeneratedKey(r.key)
      setNewKeyName('')
      router.refresh()
    })
  }

  function handleRevokeKey(keyId: string) {
    startTransition(async () => {
      const r = await revokeApiKeyAction(keyId)
      showToast(r)
      if (r.success) setRevokedIds((prev) => new Set([...prev, keyId]))
    })
  }

  function handleDeleteAccount() {
    const fd = new FormData()
    fd.set('confirmation', deleteConfirmText)
    startTransition(async () => {
      const r = await deleteAccountAction(fd)
      if (!r.success) { showToast(r); return }
      await signOut({ callbackUrl: '/login' })
    })
  }

  // ── Tabs config ───────────────────────────────────────────────────────────

  const tabs: { id: Tab; label: string; icon: string; danger?: boolean }[] = [
    { id: 'perfil',          label: 'Perfil',          icon: '👤' },
    { id: 'preferencias',    label: 'Preferencias',    icon: '⚙️' },
    { id: 'notificaciones',  label: 'Notificaciones',  icon: '🔔' },
    { id: 'api-keys',        label: 'API Keys',        icon: '🔑' },
    { id: 'peligro',         label: 'Zona de peligro', icon: '⚠️', danger: true },
  ]

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Configuración</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Gestiona tu cuenta, preferencias y accesos API
        </p>
      </div>

      {/* Toast */}
      {toast && <StatusMessage result={toast} onDismiss={() => setToast(null)} />}

      {/* Tab bar */}
      <div className="flex flex-wrap gap-0.5 border-b">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium rounded-t-md border-b-2 -mb-px transition-colors ${
              activeTab === t.id
                ? t.danger
                  ? 'border-red-500 text-red-700 bg-red-50/50'
                  : 'border-primary text-primary bg-primary/5'
                : t.danger
                  ? 'border-transparent text-red-600/70 hover:text-red-600 hover:border-red-300'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30'
            }`}
          >
            <span className="text-base leading-none">{t.icon}</span>
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

      {/* ── Perfil ────────────────────────────────────────────────────────── */}
      {activeTab === 'perfil' && (
        <div className="space-y-4">
          {/* Account info */}
          <div className="rounded-lg border bg-card p-6 space-y-4">
            <h2 className="text-base font-semibold">Información de cuenta</h2>
            <div className="flex items-center gap-4 pb-4 border-b">
              <span className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-semibold shrink-0">
                {(user.name ?? user.email ?? '?').charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="font-medium text-sm truncate">{user.name ?? '—'}</p>
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              </div>
              <span className="ml-auto bg-primary/10 text-primary px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide shrink-0">
                {user.plan}
              </span>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Nombre para mostrar</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={60}
                  placeholder="Tu nombre"
                  className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button
                  onClick={handleUpdateProfile}
                  disabled={isPending || !name.trim() || name === (user.name ?? '')}
                  className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
                >
                  Guardar
                </button>
              </div>
            </div>
          </div>

          {/* Password change */}
          <div className="rounded-lg border bg-card p-6 space-y-4">
            <h2 className="text-base font-semibold">Cambiar contraseña</h2>
            {!user.hasPassword ? (
              <p className="text-sm text-muted-foreground bg-muted/60 rounded-md px-3 py-2">
                Tu cuenta usa inicio de sesión con Google. Las contraseñas locales no están disponibles para cuentas OAuth.
              </p>
            ) : (
              <div className="space-y-3">
                <InputField
                  label="Contraseña actual"
                  type="password"
                  value={currentPw}
                  onChange={setCurrentPw}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
                <InputField
                  label="Nueva contraseña"
                  type="password"
                  value={newPw}
                  onChange={setNewPw}
                  placeholder="Mínimo 8 caracteres"
                  autoComplete="new-password"
                />
                <InputField
                  label="Confirmar nueva contraseña"
                  type="password"
                  value={confirmPw}
                  onChange={setConfirmPw}
                  placeholder="Repite la nueva contraseña"
                  autoComplete="new-password"
                />
                {newPw && confirmPw && newPw !== confirmPw && (
                  <p className="text-xs text-red-600">Las contraseñas no coinciden</p>
                )}
                <button
                  onClick={handleChangePassword}
                  disabled={
                    isPending ||
                    !currentPw ||
                    !newPw ||
                    !confirmPw ||
                    newPw !== confirmPw ||
                    newPw.length < 8
                  }
                  className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
                >
                  {isPending ? 'Actualizando…' : 'Cambiar contraseña'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Preferencias ──────────────────────────────────────────────────── */}
      {activeTab === 'preferencias' && (
        <div className="rounded-lg border bg-card p-6 space-y-5">
          <h2 className="text-base font-semibold">Preferencias de aplicación</h2>

          <div className="space-y-2">
            <label className="text-sm font-medium">Zona horaria</label>
            <p className="text-xs text-muted-foreground">
              Utilizada para mostrar fechas y calcular los periodos de informe.
            </p>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2 pt-2 border-t text-sm text-muted-foreground">
            <div className="flex justify-between py-1.5">
              <span>Moneda principal</span>
              <span className="font-medium text-foreground">EUR (€)</span>
            </div>
            <div className="flex justify-between py-1.5">
              <span>Idioma</span>
              <span className="font-medium text-foreground">Español</span>
            </div>
          </div>

          <button
            onClick={handleUpdatePreferences}
            disabled={isPending || timezone === user.timezone}
            className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
          >
            {isPending ? 'Guardando…' : 'Guardar preferencias'}
          </button>
        </div>
      )}

      {/* ── Notificaciones ────────────────────────────────────────────────── */}
      {activeTab === 'notificaciones' && (
        <div className="rounded-lg border bg-card p-6 space-y-5">
          <h2 className="text-base font-semibold">Notificaciones por email</h2>
          <p className="text-xs text-muted-foreground -mt-2">
            Los emails se envían a{' '}
            <strong className="text-foreground">{user.email}</strong>.
          </p>

          <div className="space-y-0 divide-y">
            <div className="flex items-start justify-between gap-4 py-4">
              <div>
                <p className="text-sm font-medium">Alerta de inicio de sesión</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Recibe un aviso cada vez que se inicia sesión en tu cuenta.
                </p>
              </div>
              <Toggle value={emailLoginAlert} onChange={setEmailLoginAlert} />
            </div>

            <div className="flex items-start justify-between gap-4 py-4">
              <div>
                <p className="text-sm font-medium">Confirmación de liquidación</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Recibe un resumen cuando liquidas una apuesta (ganada o perdida).
                </p>
              </div>
              <Toggle value={emailOnSettle} onChange={setEmailOnSettle} />
            </div>
          </div>

          <button
            onClick={handleUpdateNotifications}
            disabled={
              isPending ||
              (emailLoginAlert === settings.emailLoginAlert &&
                emailOnSettle === settings.emailOnSettle)
            }
            className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
          >
            {isPending ? 'Guardando…' : 'Guardar preferencias'}
          </button>
        </div>
      )}

      {/* ── API Keys ──────────────────────────────────────────────────────── */}
      {activeTab === 'api-keys' && (
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold">Claves API</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Úsalas para integrar el tracker con bots de Telegram, scripts o herramientas externas.
                Cada clave <strong>solo se muestra una vez</strong> al generarla.
              </p>
            </div>

            {/* Generated key reveal banner */}
            {generatedKey && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                <p className="text-xs font-semibold text-amber-800">
                  ⚠️ Guarda esta clave ahora — no volverá a mostrarse
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 rounded bg-white border px-2 py-1.5 text-xs font-mono break-all text-amber-900">
                    {generatedKey}
                  </code>
                  <button
                    onClick={copyKey}
                    className="shrink-0 rounded-md border bg-white px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
                  >
                    {copiedKey ? '✓ Copiado' : 'Copiar'}
                  </button>
                </div>
                <button
                  onClick={() => setGeneratedKey(null)}
                  className="text-xs text-amber-700 underline underline-offset-2"
                >
                  He guardado la clave, cerrar
                </button>
              </div>
            )}

            {/* Key list */}
            {visibleKeys.length > 0 ? (
              <div className="space-y-2">
                {visibleKeys.map((key) => (
                  <div
                    key={key.id}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 bg-background text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{key.name}</p>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">
                        {key.keyPrefix}…
                        {key.lastUsedAt
                          ? ` · Último uso: ${new Date(key.lastUsedAt).toLocaleDateString('es-ES')}`
                          : ' · Nunca usada'}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRevokeKey(key.id)}
                      disabled={isPending}
                      className="shrink-0 rounded-md border border-red-200 text-red-700 px-2.5 py-1 text-xs font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
                    >
                      Revocar
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-6">
                No hay claves API activas
              </p>
            )}
          </div>

          {/* Generate new key */}
          {visibleKeys.length < 5 && (
            <div className="rounded-lg border bg-card p-6 space-y-3">
              <h3 className="text-sm font-semibold">Generar nueva clave</h3>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="Nombre (ej: Bot Telegram principal)"
                  maxLength={50}
                  className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button
                  onClick={handleGenerateKey}
                  disabled={isPending || !newKeyName.trim()}
                  className="shrink-0 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
                >
                  {isPending ? '…' : 'Generar'}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Permisos por defecto:{' '}
                <code className="bg-muted px-1 rounded">records:read</code>{' '}
                <code className="bg-muted px-1 rounded">bookmakers:read</code>
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Zona de peligro ───────────────────────────────────────────────── */}
      {activeTab === 'peligro' && (
        <div className="rounded-lg border border-red-200 bg-red-50/40 p-6 space-y-4">
          <h2 className="text-base font-semibold text-red-800">Zona de peligro</h2>
          <p className="text-sm text-red-700">
            Eliminar tu cuenta es una acción{' '}
            <strong>permanente e irreversible</strong>. Se borrarán todos tus datos: casas de
            apuestas, operaciones, bankrolls e historial financiero.
          </p>

          {!showDeleteConfirm ? (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="rounded-md border border-red-400 text-red-700 bg-white px-4 py-2 text-sm font-medium hover:bg-red-50 transition-colors"
            >
              Eliminar mi cuenta
            </button>
          ) : (
            <div className="space-y-3 rounded-md border border-red-300 bg-white p-4">
              <p className="text-sm font-medium text-red-800">
                Escribe{' '}
                <code className="bg-red-100 px-1 rounded font-mono">ELIMINAR</code>{' '}
                para confirmar la eliminación permanente:
              </p>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="ELIMINAR"
                className="w-full rounded-md border border-red-300 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400/50"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleDeleteAccount}
                  disabled={isPending || deleteConfirmText !== 'ELIMINAR'}
                  className="rounded-md bg-red-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50 hover:bg-red-700 transition-colors"
                >
                  {isPending ? 'Eliminando…' : 'Confirmar eliminación'}
                </button>
                <button
                  onClick={() => {
                    setShowDeleteConfirm(false)
                    setDeleteConfirmText('')
                  }}
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
