'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { Eye, EyeOff } from 'lucide-react'
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
import {
  generateLinkTokenAction,
  unlinkTelegramAction,
} from '@/lib/actions/telegram'
import { AdminTab } from './admin-tab'
import type { AdminStats, AdminUser } from '@/lib/actions/admin'

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = 'perfil' | 'preferencias' | 'notificaciones' | 'api-keys' | 'integraciones' | 'suscripcion' | 'admin' | 'peligro'

interface ApiKeyData {
  id: string
  name: string
  keyPrefix: string
  lastUsedAt: string | null
  createdAt: string
}

const CURRENCIES = [
  { code: 'EUR', label: 'EUR — Euro (€)' },
  { code: 'USD', label: 'USD — Dólar americano ($)' },
  { code: 'GBP', label: 'GBP — Libra esterlina (£)' },
  { code: 'BRL', label: 'BRL — Real brasileño (R$)' },
  { code: 'MXN', label: 'MXN — Peso mexicano ($)' },
  { code: 'COP', label: 'COP — Peso colombiano ($)' },
  { code: 'ARS', label: 'ARS — Peso argentino ($)' },
  { code: 'PEN', label: 'PEN — Sol peruano (S/)' },
  { code: 'CLP', label: 'CLP — Peso chileno ($)' },
]

export interface SettingsClientProps {
  user: {
    name: string | null
    email: string | null
    plan: string
    timezone: string
    currency: string
    hasPassword: boolean
    isAdmin: boolean
    hasEverPaid: boolean
    planExpiresAt: string | null
  }
  settings: {
    emailLoginAlert: boolean
    emailOnSettle: boolean
  }
  telegram: {
    connected: boolean
    username: string | null
  }
  admin: { stats: AdminStats; users: AdminUser[] } | null
  apiKeys: ApiKeyData[]
  initialTab?: string
  paymentSuccess?: boolean
  paymentCanceled?: boolean
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
          ? 'bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300 border-green-200 dark:border-green-800'
          : 'bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300 border-red-200 dark:border-red-800'
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
        value ? 'bg-primary' : 'bg-muted-foreground/30 dark:bg-slate-600'
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
  showToggle = false,
}: {
  label: string
  type?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  maxLength?: number
  showToggle?: boolean
}) {
  const [showPw, setShowPw] = useState(false)
  const inputType = type === 'password' && showToggle ? (showPw ? 'text' : 'password') : type

  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      <div className="relative">
        <input
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          maxLength={maxLength}
          className={`w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 ${type === 'password' && showToggle ? 'pr-10' : ''}`}
        />
        {type === 'password' && showToggle && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowPw((v) => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={showPw ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          >
            {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
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

export function SettingsClient({ user, settings, telegram, admin, apiKeys, initialTab, paymentSuccess, paymentCanceled }: SettingsClientProps) {
  const router   = useRouter()
  const [isPending, startTransition] = useTransition()
  const [activeTab, setActiveTab]    = useState<Tab>((initialTab as Tab) ?? 'perfil')
  const [toast, setToast]            = useState<SettingsResult | null>(null)
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null)

  // Profile
  const [name, setName] = useState(user.name ?? '')

  // Password
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw]         = useState('')
  const [confirmPw, setConfirmPw] = useState('')

  // Preferences
  const [timezone, setTimezone]   = useState(user.timezone)
  const [currency, setCurrency]   = useState(user.currency)
  const [language, setLanguage]   = useState('es')
  useEffect(() => {
    setLanguage(localStorage.getItem('language') ?? 'es')
  }, [])

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

  // Integraciones — FidesBot
  const [tgConnected, setTgConnected]     = useState(telegram.connected)
  const [tgUsername,  setTgUsername]      = useState(telegram.username)
  const [tgLinkData,  setTgLinkData]      = useState<{
    deepLink: string; manualToken: string; expiresAt: string
  } | null>(null)
  const [tgExpiredMsg, setTgExpiredMsg]   = useState(false)
  const [copiedToken,  setCopiedToken]    = useState(false)

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
    fd.set('currency', currency)
    localStorage.setItem('language', language)
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

  // ── Integraciones — FidesBot ─────────────────────────────────────────────

  function handleGenerateLink() {
    setTgExpiredMsg(false)
    startTransition(async () => {
      const r = await generateLinkTokenAction()
      if (!r.success) { showToast(r); return }
      setTgLinkData({ deepLink: r.deepLink, manualToken: r.manualToken, expiresAt: r.expiresAt })
      // Auto-expirar el panel a los 10 min
      setTimeout(() => {
        setTgLinkData(null)
        setTgExpiredMsg(true)
      }, 10 * 60 * 1000)
    })
  }

  function handleUnlinkTelegram() {
    startTransition(async () => {
      const r = await unlinkTelegramAction()
      showToast(r)
      if (r.success) {
        setTgConnected(false)
        setTgUsername(null)
        setTgLinkData(null)
        router.refresh()
      }
    })
  }

  // ── Checkout ─────────────────────────────────────────────────────────────
  async function handleCheckout(planKey: string) {
    setCheckoutLoading(planKey)
    try {
      const res = await fetch('/api/payments/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planKey }),
      })
      const data = await res.json() as { url?: string; error?: string }
      if (!res.ok || !data.url) {
        showToast({ success: false, error: data.error ?? 'Error al iniciar el pago' })
        return
      }
      window.location.href = data.url
    } catch {
      showToast({ success: false, error: 'Error de red al conectar con el servidor de pago' })
    } finally {
      setCheckoutLoading(null)
    }
  }

  function handleVerifyConnection() {
    // Recarga la página para ver si ya se vinculó desde el bot
    setTgLinkData(null)
    router.refresh()
  }

  // ── Tabs config ───────────────────────────────────────────────────────────

  const tabs: { id: Tab; label: string; icon: string; danger?: boolean }[] = [
    { id: 'perfil',          label: 'Perfil',          icon: '👤' },
    { id: 'preferencias',    label: 'Preferencias',    icon: '⚙️' },
    { id: 'notificaciones',  label: 'Notificaciones',  icon: '🔔' },
    { id: 'api-keys',        label: 'API Keys',        icon: '🔑' },
    { id: 'integraciones',   label: 'Integraciones',   icon: '🔗' },
    { id: 'suscripcion',     label: 'Suscripción',     icon: '💎' },
    ...(user.isAdmin ? [{ id: 'admin' as Tab, label: 'Admin', icon: '👑' }] : []),
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
                  ? 'border-red-500 text-red-700 dark:text-red-400 bg-red-50/50 dark:bg-red-950/30'
                  : 'border-primary text-primary bg-primary/5'
                : t.danger
                  ? 'border-transparent text-red-600/70 dark:text-red-500/80 hover:text-red-600 dark:hover:text-red-400 hover:border-red-300 dark:hover:border-red-700'
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
                  showToggle
                  value={currentPw}
                  onChange={setCurrentPw}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
                <InputField
                  label="Nueva contraseña"
                  type="password"
                  showToggle
                  value={newPw}
                  onChange={setNewPw}
                  placeholder="Mínimo 8 caracteres"
                  autoComplete="new-password"
                />
                <InputField
                  label="Confirmar nueva contraseña"
                  type="password"
                  showToggle
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

          {/* Moneda */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Moneda principal</label>
            <p className="text-xs text-muted-foreground">
              Se usará para mostrar importes en todo el dashboard.
            </p>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>

          {/* Idioma */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Idioma de la interfaz</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="es">🇪🇸 Español</option>
              <option value="en">🇬🇧 English (próximamente)</option>
            </select>
            {language === 'en' && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                La interfaz en inglés está en desarrollo — tu preferencia se guardará y se activará cuando esté disponible.
              </p>
            )}
          </div>

          <button
            onClick={handleUpdatePreferences}
            disabled={isPending || (timezone === user.timezone && currency === user.currency)}
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
              <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-3 space-y-2">
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                  ⚠️ Guarda esta clave ahora — no volverá a mostrarse
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 rounded bg-white dark:bg-background border px-2 py-1.5 text-xs font-mono break-all text-amber-900 dark:text-amber-200">
                    {generatedKey}
                  </code>
                  <button
                    onClick={copyKey}
                    className="shrink-0 rounded-md border bg-white dark:bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
                  >
                    {copiedKey ? '✓ Copiado' : 'Copiar'}
                  </button>
                </div>
                <button
                  onClick={() => setGeneratedKey(null)}
                  className="text-xs text-amber-700 dark:text-amber-400 underline underline-offset-2"
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
                      className="shrink-0 rounded-md border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-2.5 py-1 text-xs font-medium hover:bg-red-50 dark:hover:bg-red-950/50 disabled:opacity-50 transition-colors"
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

      {/* ── Integraciones ─────────────────────────────────────────────────── */}
      {activeTab === 'integraciones' && (
        <div className="space-y-4">

          {/* ── Tarjeta FidesBot ──────────────────────────── */}
          <div className="rounded-lg border bg-card p-6 space-y-5">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🤖</span>
              <div>
                <h2 className="text-base font-semibold">FidesBot</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Bot de Telegram para alertas de surebets en tiempo real
                </p>
              </div>
              <span className={`ml-auto text-xs font-semibold px-2.5 py-1 rounded-full shrink-0 ${
                tgConnected
                  ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400'
                  : 'bg-muted text-muted-foreground'
              }`}>
                {tgConnected ? '✓ Conectado' : 'No conectado'}
              </span>
            </div>

            <p className="text-sm text-muted-foreground leading-relaxed">
              Vincula tu cuenta para que cada apuesta que marques como{' '}
              <strong className="text-foreground">✅ Hecha</strong> en FidesBot se registre
              automáticamente aquí. Tus estadísticas de P&L, ROI y yield se actualizan solos.
            </p>

            {/* ── Plan FREE: bloquear ───────────────────────── */}
            {user.plan === 'FREE' && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 flex items-center gap-3 text-sm">
                <span className="text-amber-600 dark:text-amber-400 shrink-0">💎</span>
                <span className="text-amber-800 dark:text-amber-300">
                  La integración con FidesBot requiere plan PRO.
                </span>
                <a
                  href="/settings"
                  className="ml-auto shrink-0 font-semibold text-amber-700 dark:text-amber-300 underline underline-offset-2 hover:no-underline"
                >
                  Actualizar →
                </a>
              </div>
            )}

            {/* ── PRO: conectado ────────────────────────────── */}
            {user.plan !== 'FREE' && tgConnected && !tgLinkData && (
              <div className="space-y-4">
                <div className="flex items-center gap-3 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 px-4 py-3">
                  <span className="text-xl">✅</span>
                  <div>
                    <p className="text-sm font-semibold text-green-800 dark:text-green-300">
                      Cuenta vinculada
                      {tgUsername && (
                        <span className="font-normal text-green-700 dark:text-green-400 ml-1">
                          · @{tgUsername}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-green-700 dark:text-green-500 mt-0.5">
                      Las apuestas se registran automáticamente desde FidesBot.
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleUnlinkTelegram}
                  disabled={isPending}
                  className="rounded-md border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-2 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-950/50 disabled:opacity-50 transition-colors"
                >
                  {isPending ? 'Desvinculando…' : 'Desvincular FidesBot'}
                </button>
              </div>
            )}

            {/* ── PRO: no conectado — botón inicial ─────────── */}
            {user.plan !== 'FREE' && !tgConnected && !tgLinkData && (
              <div className="space-y-3">
                {tgExpiredMsg && (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    ⏱ El enlace anterior ha caducado. Genera uno nuevo.
                  </p>
                )}
                <button
                  onClick={handleGenerateLink}
                  disabled={isPending}
                  className="rounded-md bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold disabled:opacity-50 hover:bg-primary/90 transition-colors"
                >
                  {isPending ? 'Generando enlace…' : '🔗 Conectar FidesBot'}
                </button>
              </div>
            )}

            {/* ── Enlace generado — panel de vinculación ─────── */}
            {tgLinkData && (
              <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
                <div>
                  <p className="text-sm font-semibold">
                    Abre FidesBot en Telegram y pulsa el botón:
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    El enlace caduca en 10 minutos.
                  </p>
                </div>

                {/* Deep link button */}
                <a
                  href={tgLinkData.deepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full rounded-xl bg-[#229ED9] text-white px-6 py-3 text-sm font-bold hover:bg-[#1a8bc2] transition-colors shadow-md"
                >
                  <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current" aria-hidden="true">
                    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
                  </svg>
                  Abrir FidesBot y conectar
                </a>

                {/* Manual option */}
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    O escribe esto en FidesBot (menú → /start):
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 min-w-0 rounded-md bg-background border px-3 py-2 text-xs font-mono break-all">
                      /start {tgLinkData.manualToken}
                    </code>
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(`/start ${tgLinkData.manualToken}`)
                        setCopiedToken(true)
                        setTimeout(() => setCopiedToken(false), 2000)
                      }}
                      className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                        copiedToken
                          ? 'bg-green-100 border-green-300 text-green-700'
                          : 'bg-background hover:bg-muted'
                      }`}
                    >
                      {copiedToken ? '✓ Copiado' : 'Copiar'}
                    </button>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleVerifyConnection}
                    className="flex-1 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
                  >
                    ✓ Verificar conexión
                  </button>
                  <button
                    onClick={() => { setTgLinkData(null); setTgExpiredMsg(false) }}
                    className="rounded-md border px-4 py-2 text-sm text-muted-foreground hover:bg-muted transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── Hint sobre el flujo ───────────────────────────── */}
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground space-y-1.5">
            <p className="font-medium text-foreground">¿Cómo funciona?</p>
            <ol className="list-decimal list-inside space-y-1 text-xs">
              <li>Conecta tu cuenta pulsando el botón de arriba.</li>
              <li>Cuando llegue una alerta en FidesBot, pulsa <strong className="text-foreground">✅ Hecha</strong>.</li>
              <li>La apuesta queda en <em>pendientes</em>. Completa los datos reales cuando puedas.</li>
              <li>El registro aparece aquí automáticamente con P&L, ROI y yield calculados.</li>
            </ol>
          </div>

        </div>
      )}

      {/* ── Suscripción ───────────────────────────────────────────────────── */}
      {activeTab === 'suscripcion' && (
        <div className="space-y-4">

          {/* Notificaciones de pago */}
          {(paymentSuccess || paymentCanceled) && (
            <div className={`rounded-md px-4 py-3 text-sm border ${
              paymentSuccess
                ? 'bg-green-50 border-green-200 text-green-800 dark:bg-green-950/40 dark:border-green-800 dark:text-green-300'
                : 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-300'
            }`}>
              {paymentSuccess
                ? '✅ ¡Pago completado! Tu plan ha sido activado. Puede tardar unos segundos en actualizarse.'
                : '↩️ Pago cancelado. No se ha realizado ningún cargo.'}
            </div>
          )}

          {/* Plan actual */}
          {user.plan !== 'FREE' && (
            <div className="rounded-lg border bg-card p-4 flex items-center gap-3">
              <span className="text-2xl">✨</span>
              <div>
                <p className="text-sm font-semibold">
                  Plan activo:{' '}
                  <span className="text-primary">
                    {user.plan === 'PRO_TRACKER' ? 'PRO+Tracker' : user.plan}
                  </span>
                </p>
                {user.planExpiresAt && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Expira el{' '}
                    {new Date(user.planExpiresAt).toLocaleDateString('es-ES', {
                      day: 'numeric', month: 'long', year: 'numeric',
                    })}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ── Tarjetas de planes ─────────────────────────────────────────── */}
          <div className="grid gap-3 sm:grid-cols-2">

            {/* PRO — 1 semana */}
            <div className="rounded-lg border bg-card p-5 space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">PRO</p>
                <p className="text-lg font-bold mt-0.5">1 semana</p>
                <p className="text-2xl font-extrabold text-primary mt-1">17€</p>
                <p className="text-xs text-muted-foreground mt-0.5">Pago único · Sin renovación</p>
              </div>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>✓ Acceso completo a DualStats</li>
                <li>✓ P&L, ROI y yield en tiempo real</li>
                <li>✓ Historial ilimitado</li>
              </ul>
              <button
                onClick={() => handleCheckout('pro_7')}
                disabled={checkoutLoading !== null}
                className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-semibold disabled:opacity-50 hover:bg-primary/90 transition-colors"
              >
                {checkoutLoading === 'pro_7' ? 'Redirigiendo…' : 'Comprar — 17€'}
              </button>
            </div>

            {/* PRO — 2 semanas */}
            <div className="rounded-lg border bg-card p-5 space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">PRO</p>
                <p className="text-lg font-bold mt-0.5">2 semanas</p>
                <p className="text-2xl font-extrabold text-primary mt-1">25€</p>
                <p className="text-xs text-muted-foreground mt-0.5">Pago único · Sin renovación</p>
              </div>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>✓ Acceso completo a DualStats</li>
                <li>✓ P&L, ROI y yield en tiempo real</li>
                <li>✓ Historial ilimitado</li>
              </ul>
              <button
                onClick={() => handleCheckout('pro_14')}
                disabled={checkoutLoading !== null}
                className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-semibold disabled:opacity-50 hover:bg-primary/90 transition-colors"
              >
                {checkoutLoading === 'pro_14' ? 'Redirigiendo…' : 'Comprar — 25€'}
              </button>
            </div>

            {/* PRO — 1 mes (destacado) */}
            <div className="rounded-lg border-2 border-primary bg-card p-5 space-y-3 relative">
              <span className="absolute -top-3 left-4 bg-primary text-primary-foreground text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">
                ⭐ Más popular
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">PRO</p>
                <p className="text-lg font-bold mt-0.5">1 mes</p>
                <div className="flex items-baseline gap-2 mt-1">
                  <p className="text-2xl font-extrabold text-primary">
                    {!user.hasEverPaid ? '35€' : '45€'}
                  </p>
                  {!user.hasEverPaid && (
                    <span className="text-sm text-muted-foreground line-through">45€</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {!user.hasEverPaid
                    ? '🎁 Descuento bienvenida · Solo primera vez'
                    : 'Pago único · Sin renovación'}
                </p>
              </div>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>✓ Acceso completo a DualStats</li>
                <li>✓ P&L, ROI y yield en tiempo real</li>
                <li>✓ Historial ilimitado</li>
              </ul>
              <button
                onClick={() => handleCheckout('pro_30')}
                disabled={checkoutLoading !== null}
                className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-semibold disabled:opacity-50 hover:bg-primary/90 transition-colors"
              >
                {checkoutLoading === 'pro_30'
                  ? 'Redirigiendo…'
                  : `Comprar — ${!user.hasEverPaid ? '35€' : '45€'}`}
              </button>
            </div>

            {/* PRO+Tracker — 1 mes */}
            <div className="rounded-lg border border-indigo-300 dark:border-indigo-700 bg-card p-5 space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">PRO+Tracker</p>
                <p className="text-lg font-bold mt-0.5">1 mes</p>
                <div className="flex items-baseline gap-2 mt-1">
                  <p className="text-2xl font-extrabold text-indigo-600 dark:text-indigo-400">
                    {!user.hasEverPaid ? '39,99€' : '49,99€'}
                  </p>
                  {!user.hasEverPaid && (
                    <span className="text-sm text-muted-foreground line-through">49,99€</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {!user.hasEverPaid
                    ? '🎁 Descuento bienvenida · Solo primera vez'
                    : 'Pago único · Sin renovación'}
                </p>
              </div>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>✓ Todo lo de PRO</li>
                <li>✓ <strong className="text-foreground">Integración FidesBot</strong></li>
                <li>✓ Registro automático de apuestas</li>
              </ul>
              <button
                onClick={() => handleCheckout('tracker_30')}
                disabled={checkoutLoading !== null}
                className="w-full rounded-md bg-indigo-600 text-white py-2 text-sm font-semibold disabled:opacity-50 hover:bg-indigo-700 transition-colors"
              >
                {checkoutLoading === 'tracker_30'
                  ? 'Redirigiendo…'
                  : `Comprar — ${!user.hasEverPaid ? '39,99€' : '49,99€'}`}
              </button>
            </div>

          </div>

          <p className="text-xs text-center text-muted-foreground">
            Pago seguro con Stripe · Sin suscripción · Sin cargos inesperados
          </p>
        </div>
      )}

      {/* ── Admin ─────────────────────────────────────────────────────────── */}
      {activeTab === 'admin' && user.isAdmin && admin && (
        <AdminTab initialStats={admin.stats} initialUsers={admin.users} />
      )}

      {/* ── Zona de peligro ───────────────────────────────────────────────── */}
      {activeTab === 'peligro' && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50/40 dark:bg-red-950/30 p-6 space-y-4">
          <h2 className="text-base font-semibold text-red-800 dark:text-red-300">Zona de peligro</h2>
          <p className="text-sm text-red-700 dark:text-red-300/80">
            Eliminar tu cuenta es una acción{' '}
            <strong>permanente e irreversible</strong>. Se borrarán todos tus datos: casas de
            apuestas, operaciones, bankrolls e historial financiero.
          </p>

          {!showDeleteConfirm ? (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="rounded-md border border-red-400 dark:border-red-700 text-red-700 dark:text-red-400 bg-white dark:bg-transparent px-4 py-2 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
            >
              Eliminar mi cuenta
            </button>
          ) : (
            <div className="space-y-3 rounded-md border border-red-300 dark:border-red-800 bg-white dark:bg-card p-4">
              <p className="text-sm font-medium text-red-800 dark:text-red-300">
                Escribe{' '}
                <code className="bg-red-100 dark:bg-red-950 dark:text-red-300 px-1 rounded font-mono">ELIMINAR</code>{' '}
                para confirmar la eliminación permanente:
              </p>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="ELIMINAR"
                className="w-full rounded-md border border-red-300 dark:border-red-700 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400/50"
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
