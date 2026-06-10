/**
 * lib/services/email.ts
 *
 * Servicio de email usando la Resend REST API (sin npm install).
 * En entorno de desarrollo (RESEND_API_KEY empieza con 're_dev')
 * se imprime en consola en lugar de hacer la petición real.
 */

const RESEND_API = 'https://api.resend.com/emails'
const API_KEY    = process.env.RESEND_API_KEY ?? ''
const FROM       = process.env.EMAIL_FROM ?? 'DualStats Tracker <noreply@surebettracker.pro>'
const IS_LIVE    = !!API_KEY && !API_KEY.startsWith('re_dev') && !API_KEY.startsWith('re_placeholder')

interface EmailPayload {
  to:      string
  subject: string
  html:    string
}

async function sendEmail(payload: EmailPayload): Promise<void> {
  if (!IS_LIVE) {
    console.warn('[Email] Dev mode — skipped send to:', payload.to, '|', payload.subject)
    return
  }

  try {
    const res = await fetch(RESEND_API, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    FROM,
        to:      [payload.to],
        subject: payload.subject,
        html:    payload.html,
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('[Email] Resend API error:', err)
    }
  } catch (err) {
    console.error('[Email] Network error:', err)
  }
}

// ─── Plantillas ─────────────────────────────────────────────────────────────

const baseStyle = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  line-height: 1.6; color: #1a1a1a; background: #f5f5f5;
`

function baseLayout(content: string): string {
  return `
    <div style="${baseStyle}">
      <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
        <!-- Header -->
        <div style="background:#111;padding:24px 32px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.5px;">
            DualStats Tracker
          </p>
        </div>
        <!-- Body -->
        <div style="padding:32px;">
          ${content}
        </div>
        <!-- Footer -->
        <div style="border-top:1px solid #e5e5e5;padding:16px 32px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#888;">
            DualStats Tracker · <a href="https://surebettracker.pro" style="color:#888;">surebettracker.pro</a>
          </p>
        </div>
      </div>
    </div>
  `
}

// ─── Bienvenida al registrarse ───────────────────────────────────────────────

export async function sendWelcomeEmail(email: string, name: string | null): Promise<void> {
  const displayName = name ?? 'Inversor'
  const html = baseLayout(`
    <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;">¡Bienvenido, ${displayName}! 🎉</h1>
    <p style="margin:0 0 16px;color:#444;">
      Tu cuenta en <strong>DualStats Tracker</strong> ha sido creada correctamente.
      Ya puedes registrar tus operaciones, analizar tu rendimiento y hacer un seguimiento
      de tu bankroll en tiempo real.
    </p>
    <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3010'}/dashboard"
       style="display:inline-block;background:#111;color:#fff;text-decoration:none;
              font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;margin:8px 0;">
      Ir al Dashboard →
    </a>
    <p style="margin:24px 0 0;font-size:13px;color:#888;">
      Si no has creado esta cuenta, puedes ignorar este mensaje.
    </p>
  `)

  await sendEmail({
    to:      email,
    subject: '¡Bienvenido a DualStats Tracker! 🎉',
    html,
  })
}

// ─── Confirmación de liquidación ────────────────────────────────────────────

export async function sendSettleEmail(
  email:  string,
  name:   string | null,
  data: {
    status:    string
    stake:     number
    profit:    number
    currency?: string
  },
): Promise<void> {
  const displayName = name ?? email
  const currency    = data.currency ?? 'EUR'

  const STATUS_LABELS: Record<string, string> = {
    WON:     '✅ Ganada',
    LOST:    '❌ Perdida',
    VOID:    '↩️ Anulada',
    CASHOUT: '💰 Cashout',
  }
  const statusLabel     = STATUS_LABELS[data.status] ?? data.status
  const isProfit        = data.profit >= 0
  const sign            = isProfit ? '+' : ''
  const profitColor     = isProfit ? '#16a34a' : '#dc2626'
  const profitFormatted = `${sign}${data.profit.toLocaleString('es-ES', { style: 'currency', currency })}`
  const stakeFormatted  = data.stake.toLocaleString('es-ES', { style: 'currency', currency })

  const html = baseLayout(`
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;">Apuesta liquidada ${statusLabel}</h2>
    <p style="margin:0 0 16px;color:#444;">
      Hola <strong>${displayName}</strong>, una operación en tu cuenta ha sido liquidada.
    </p>
    <div style="background:#f8f8f8;border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin:0 0 20px;">
      <p style="margin:0;font-size:14px;"><strong>Estado:</strong> ${statusLabel}</p>
      <p style="margin:6px 0 0;font-size:14px;"><strong>Stake:</strong> ${stakeFormatted}</p>
      <p style="margin:6px 0 0;font-size:14px;"><strong>P&amp;L:</strong>
        <span style="color:${profitColor};font-weight:700;">${profitFormatted}</span>
      </p>
    </div>
    <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3010'}/records"
       style="display:inline-block;background:#111;color:#fff;text-decoration:none;
              font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;">
      Ver operaciones →
    </a>
  `)

  await sendEmail({
    to:      email,
    subject: `${statusLabel} — Operación liquidada · DualStats Tracker`,
    html,
  })
}

// ─── Exportación CSV ────────────────────────────────────────────────────────

export async function sendCsvExportEmail(
  email:    string,
  name:     string | null,
  filename: string,
  buffer:   ArrayBuffer | Buffer<ArrayBufferLike>,
): Promise<void> {
  const displayName = name ?? email
  const html = baseLayout(`
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;">Tu exportación está lista 📊</h2>
    <p style="margin:0 0 16px;color:#444;">
      Hola <strong>${displayName}</strong>, aquí tienes el archivo con tus operaciones exportadas.
      Lo encontrarás adjunto a este correo.
    </p>
    <div style="background:#f8f8f8;border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin:0 0 20px;">
      <p style="margin:0;font-size:14px;"><strong>Archivo:</strong> ${filename}</p>
      <p style="margin:4px 0 0;font-size:13px;color:#888;">Formato Excel (.xlsx) — compatible con Excel, Google Sheets y LibreOffice Calc.</p>
    </div>
    <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3010'}/records"
       style="display:inline-block;background:#111;color:#fff;text-decoration:none;
              font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;">
      Ver operaciones →
    </a>
  `)

  if (!IS_LIVE) {
    console.warn('[Email] Dev mode — skipped CSV export email to:', email)
    return
  }

  try {
    const base64Content = (Buffer.isBuffer(buffer) ? buffer : Buffer.from(new Uint8Array(buffer as ArrayBuffer))).toString('base64')
    const res = await fetch(RESEND_API, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:        FROM,
        to:          [email],
        subject:     `📊 Tu exportación de operaciones — ${filename}`,
        html,
        attachments: [{ filename, content: base64Content }],
      }),
    })
    if (!res.ok) console.error('[Email] CSV export error:', await res.text())
  } catch (err) {
    console.error('[Email] CSV export network error:', err)
  }
}

// ─── Aviso de expiración de plan (24 h antes) ────────────────────────────────

const PLAN_LABEL: Record<string, string> = {
  PRO:         'PRO',
  PRO_TRACKER: 'PRO + Tracker',
  ENTERPRISE:  'Enterprise',
}

export async function sendPlanExpiryEmail(
  email:        string,
  name:         string | null,
  plan:         string,
  expiresAt:    Date,
): Promise<void> {
  const displayName = name ?? email
  const planLabel   = PLAN_LABEL[plan] ?? plan
  const expiryFmt   = expiresAt.toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Europe/Madrid',
  })
  const expiryTime = expiresAt.toLocaleTimeString('es-ES', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid',
  })

  const html = baseLayout(`
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;">Tu plan expira mañana ⏰</h2>
    <p style="margin:0 0 16px;color:#444;">
      Hola <strong>${displayName}</strong>, tu plan <strong>${planLabel}</strong> vence
      el <strong>${expiryFmt} a las ${expiryTime}</strong>.
    </p>
    <p style="margin:0 0 20px;color:#444;">
      Si no renuevas antes de esa fecha, tu cuenta pasará automáticamente al plan Free
      y perderás acceso a las funciones avanzadas.
    </p>
    <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3010'}/settings"
       style="display:inline-block;background:#111;color:#fff;text-decoration:none;
              font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;margin:0 0 20px;">
      Renovar plan →
    </a>
    <p style="margin:0;font-size:13px;color:#888;">
      Si ya has renovado tu suscripción, ignora este mensaje.
    </p>
  `)

  await sendEmail({
    to:      email,
    subject: `⏰ Tu plan ${planLabel} expira mañana — DualStats Tracker`,
    html,
  })
}

// ─── Notificación de inicio de sesión ───────────────────────────────────────

export async function sendLoginNotificationEmail(email: string, name: string | null): Promise<void> {
  const displayName = name ?? email
  const now         = new Date().toLocaleString('es-ES', {
    timeZone:     'Europe/Madrid',
    dateStyle:    'long',
    timeStyle:    'short',
  })

  const html = baseLayout(`
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;">Nuevo inicio de sesión 🔐</h2>
    <p style="margin:0 0 16px;color:#444;">
      Hola <strong>${displayName}</strong>, se ha detectado un nuevo inicio de sesión
      en tu cuenta de DualStats Tracker.
    </p>
    <div style="background:#f8f8f8;border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin:0 0 16px;">
      <p style="margin:0;font-size:14px;"><strong>Fecha y hora:</strong> ${now}</p>
      <p style="margin:4px 0 0;font-size:14px;color:#888;">Acceso desde credenciales</p>
    </div>
    <p style="margin:0;font-size:13px;color:#888;">
      Si no has sido tú, cambia tu contraseña inmediatamente desde
      <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3010'}/settings" style="color:#111;">
        Configuración
      </a>.
    </p>
  `)

  await sendEmail({
    to:      email,
    subject: '⚠️ Nuevo inicio de sesión en tu cuenta',
    html,
  })
}
