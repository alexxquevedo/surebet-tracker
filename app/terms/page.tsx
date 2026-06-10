import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Términos y Condiciones — DualStats Tracker',
  description: 'Términos de uso y condiciones del servicio de DualStats Tracker.',
}

const LAST_UPDATED = '10 de junio de 2026'
const APP_NAME     = 'DualStats Tracker'
const COMPANY      = 'DualStats Tracker'
const CONTACT_EMAIL = 'legal@surebettracker.pro'
const APP_URL      = 'https://surebettracker.pro'

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 py-12">

        {/* Back */}
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground mb-8 inline-flex items-center gap-1 transition-colors">
          ← Volver
        </Link>

        <h1 className="text-3xl font-bold tracking-tight mt-4 mb-2">{APP_NAME}</h1>
        <h2 className="text-xl font-semibold text-muted-foreground mb-1">Términos y Condiciones de Uso</h2>
        <p className="text-sm text-muted-foreground mb-10">Última actualización: {LAST_UPDATED}</p>

        <div className="prose prose-sm dark:prose-invert max-w-none space-y-8 text-foreground">

          <Section title="1. Objeto y aceptación">
            <p>
              Los presentes Términos y Condiciones regulan el acceso y uso del servicio <strong>{APP_NAME}</strong>
              (en adelante, "el Servicio"), disponible en <a href={APP_URL} className="text-primary hover:underline">{APP_URL}</a> y
              a través del bot de Telegram FidesBot.
            </p>
            <p>
              Al crear una cuenta, acceder al Servicio o utilizar cualquiera de sus funcionalidades, el usuario
              acepta plena e incondicionalmente los presentes Términos. Si no está de acuerdo, debe abstenerse
              de utilizar el Servicio.
            </p>
          </Section>

          <Section title="2. Descripción del Servicio">
            <p>
              {APP_NAME} es una herramienta de <strong>registro, seguimiento y análisis estadístico</strong> de
              operaciones de apuestas deportivas, incluyendo surebets (arbitraje), middlebets y apuestas
              individuales. El Servicio también incluye integración con el bot de Telegram FidesBot para
              registro automatizado de operaciones.
            </p>
            <p>
              <strong>El Servicio es exclusivamente una herramienta de registro y análisis de datos.</strong>{' '}
              {COMPANY} no ofrece consejos de apuestas, no gestiona dinero de terceros, no opera como casa de
              apuestas ni como plataforma de juego.
            </p>
          </Section>

          <Section title="3. Requisitos de uso">
            <ul>
              <li>El usuario debe ser mayor de edad conforme a la legislación aplicable en su país de residencia y tener la edad mínima legal para participar en actividades de apuestas deportivas.</li>
              <li>El uso del Servicio para actividades ilegales queda expresamente prohibido.</li>
              <li>El usuario es responsable de cumplir con las normativas fiscales y de juego vigentes en su jurisdicción.</li>
              <li>Está prohibido registrar más de una cuenta por persona física o jurídica.</li>
            </ul>
          </Section>

          <Section title="4. Registro de cuenta">
            <p>
              Para acceder al Servicio es necesario crear una cuenta mediante email y contraseña, o a través
              de proveedores de autenticación de terceros (Google). El usuario se compromete a:
            </p>
            <ul>
              <li>Proporcionar información veraz, completa y actualizada durante el registro.</li>
              <li>Mantener la confidencialidad de sus credenciales de acceso.</li>
              <li>Notificar inmediatamente cualquier uso no autorizado de su cuenta.</li>
              <li>Utilizar un nombre de usuario único que no infrinja derechos de terceros.</li>
            </ul>
            <p>
              {COMPANY} se reserva el derecho de suspender o eliminar cuentas que incumplan estos Términos,
              usen credenciales falsas o realicen usos abusivos del Servicio.
            </p>
          </Section>

          <Section title="5. Planes y precios">
            <p>
              El Servicio ofrece diferentes planes de suscripción (Free, PRO y PRO+Tracker) con distintas
              funcionalidades. Los precios y características de cada plan se publican en la página de
              configuración de la cuenta.
            </p>
            <ul>
              <li>Los planes de pago se facturan mediante Stripe. Al suscribirse, el usuario acepta los términos de servicio de Stripe.</li>
              <li>Los pagos no son reembolsables, salvo obligación legal en contrario.</li>
              <li>El plan activo permanece vigente hasta su fecha de expiración aunque el usuario cancele antes.</li>
              <li>{COMPANY} se reserva el derecho de modificar los precios con un aviso previo de 30 días.</li>
              <li>Los planes de prueba o promocionales están sujetos a condiciones específicas que se comunicarán en cada caso.</li>
            </ul>
          </Section>

          <Section title="6. Uso aceptable">
            <p>Está expresamente prohibido:</p>
            <ul>
              <li>Intentar acceder a cuentas de otros usuarios o a partes no autorizadas del sistema.</li>
              <li>Realizar ingeniería inversa, descompilar o intentar obtener el código fuente del Servicio.</li>
              <li>Utilizar bots, scripts o sistemas automatizados para sobrecargar el Servicio.</li>
              <li>Revender, sublicenciar o transferir el acceso a terceros sin autorización expresa.</li>
              <li>Publicar, transmitir o almacenar contenido ilegal, difamatorio o que vulnere derechos de terceros.</li>
            </ul>
          </Section>

          <Section title="7. Propiedad intelectual">
            <p>
              Todos los derechos de propiedad intelectual sobre el Servicio, incluyendo el software,
              diseño, logotipos, textos y demás elementos, son propiedad de {COMPANY} o de sus
              licenciantes. Queda prohibida su reproducción o distribución sin autorización escrita.
            </p>
            <p>
              Los datos introducidos por el usuario (operaciones, estadísticas, notas) son propiedad
              del usuario. {COMPANY} no reivindica derechos sobre el contenido generado por los usuarios.
            </p>
          </Section>

          <Section title="8. Privacidad y tratamiento de datos">
            <p>
              El tratamiento de datos personales se rige por nuestra{' '}
              <Link href="/privacy" className="text-primary hover:underline">Política de Privacidad</Link>,
              que forma parte integrante de estos Términos.
            </p>
          </Section>

          <Section title="9. Exención de responsabilidad">
            <p>
              El Servicio se proporciona «tal cual» (<em>as is</em>). {COMPANY} no garantiza que el Servicio
              esté libre de errores, interrupciones o vulnerabilidades de seguridad.
            </p>
            <p>
              <strong>{COMPANY} no será responsable en ningún caso de:</strong>
            </p>
            <ul>
              <li>Las pérdidas económicas derivadas de las apuestas o actividades de juego del usuario.</li>
              <li>Decisiones de apuestas tomadas basándose en los datos o estadísticas del Servicio.</li>
              <li>Pérdida de datos por causas ajenas a {COMPANY} (fallos de hardware, desastres naturales, ataques externos).</li>
              <li>Daños indirectos, lucro cesante o pérdida de oportunidad.</li>
            </ul>
            <p>
              La responsabilidad total de {COMPANY} frente al usuario, en cualquier caso, estará limitada
              al importe abonado por el usuario durante los últimos 12 meses.
            </p>
          </Section>

          <Section title="10. Modificaciones del Servicio y de los Términos">
            <p>
              {COMPANY} se reserva el derecho de modificar, suspender o discontinuar cualquier parte del
              Servicio con o sin previo aviso. Asimismo, puede actualizar estos Términos en cualquier momento.
              Los cambios significativos se comunicarán por email o mediante aviso en la plataforma. El uso
              continuado del Servicio tras la publicación de los cambios implica su aceptación.
            </p>
          </Section>

          <Section title="11. Cancelación y eliminación de cuenta">
            <p>
              El usuario puede cancelar su cuenta en cualquier momento desde la sección de configuración.
              La cancelación implica la eliminación irreversible de todos los datos asociados a la cuenta
              transcurrido un período de 30 días.
            </p>
            <p>
              {COMPANY} puede suspender o eliminar cuentas que incumplan estos Términos, previa notificación
              salvo en casos de fraude o uso malicioso.
            </p>
          </Section>

          <Section title="12. Ley aplicable y jurisdicción">
            <p>
              Los presentes Términos se rigen por la legislación española. Para la resolución de cualquier
              controversia derivada de estos Términos, las partes se someten a los Juzgados y Tribunales
              competentes de España, con renuncia expresa a cualquier otro fuero que pudiera corresponderles.
            </p>
          </Section>

          <Section title="13. Contacto">
            <p>
              Para cualquier consulta sobre estos Términos, puede ponerse en contacto con nosotros en:{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>
            </p>
          </Section>

        </div>

        <div className="mt-12 pt-6 border-t flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>© 2026 {APP_NAME}</span>
          <nav className="flex gap-4">
            <Link href="/terms"   className="hover:text-foreground transition-colors font-medium">Términos de uso</Link>
            <Link href="/privacy" className="hover:text-foreground transition-colors">Privacidad</Link>
          </nav>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold text-foreground border-b pb-1">{title}</h3>
      <div className="space-y-2 text-sm text-foreground/90 leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_a]:text-primary [&_a:hover]:underline">
        {children}
      </div>
    </section>
  )
}
