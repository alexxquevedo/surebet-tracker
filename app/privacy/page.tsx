import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Política de Privacidad — DualStats Tracker',
  description: 'Política de privacidad y tratamiento de datos personales de DualStats Tracker.',
}

const LAST_UPDATED  = '10 de junio de 2026'
const APP_NAME      = 'DualStats Tracker'
const COMPANY       = 'DualStats Tracker'
const CONTACT_EMAIL = 'legal@surebettracker.pro'
const APP_URL       = 'https://surebettracker.pro'

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 py-12">

        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground mb-8 inline-flex items-center gap-1 transition-colors">
          ← Volver
        </Link>

        <h1 className="text-3xl font-bold tracking-tight mt-4 mb-2">{APP_NAME}</h1>
        <h2 className="text-xl font-semibold text-muted-foreground mb-1">Política de Privacidad</h2>
        <p className="text-sm text-muted-foreground mb-10">Última actualización: {LAST_UPDATED}</p>

        <div className="prose prose-sm dark:prose-invert max-w-none space-y-8 text-foreground">

          <Section title="1. Responsable del tratamiento">
            <p>
              El responsable del tratamiento de sus datos personales es <strong>{COMPANY}</strong>,
              accesible en <a href={APP_URL}>{APP_URL}</a>. Para ejercer sus derechos o resolver
              cualquier duda sobre privacidad, puede contactar en:{' '}
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
            </p>
          </Section>

          <Section title="2. Datos que recopilamos">
            <p>Recopilamos las siguientes categorías de datos:</p>
            <h4 className="font-semibold text-sm mt-2">2.1 Datos proporcionados por el usuario</h4>
            <ul>
              <li><strong>Cuenta:</strong> nombre de usuario, dirección de email y contraseña (almacenada en formato hash bcrypt, nunca en texto plano).</li>
              <li><strong>Operaciones:</strong> apuestas registradas, casa de apuestas, cuotas, stake, resultado y cualquier otra información que el usuario introduzca voluntariamente.</li>
              <li><strong>Configuración:</strong> zona horaria, divisa, preferencias de notificación y ajustes de la cuenta.</li>
            </ul>
            <h4 className="font-semibold text-sm mt-2">2.2 Datos generados automáticamente</h4>
            <ul>
              <li><strong>Registro de actividad:</strong> fecha y hora de inicio de sesión, dirección IP (no almacenada de forma permanente), tipo de dispositivo y navegador.</li>
              <li><strong>Integración Telegram:</strong> si el usuario vincula su cuenta con FidesBot, almacenamos el identificador de Telegram (<em>Telegram ID</em>) y el nombre de usuario de Telegram.</li>
            </ul>
            <h4 className="font-semibold text-sm mt-2">2.3 Datos de pago</h4>
            <p>
              Los pagos se procesan a través de <strong>Stripe</strong>. {APP_NAME} no almacena datos de
              tarjetas de crédito ni información bancaria. Únicamente recibimos de Stripe el identificador
              de cliente y el estado de la suscripción. Consulte la{' '}
              <a href="https://stripe.com/es/privacy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
                política de privacidad de Stripe
              </a>{' '}
              para más información.
            </p>
          </Section>

          <Section title="3. Finalidades del tratamiento">
            <p>Tratamos sus datos para las siguientes finalidades:</p>
            <ul>
              <li><strong>Prestación del servicio:</strong> gestión de la cuenta, almacenamiento y análisis de operaciones de apuestas, generación de estadísticas y exportación de datos.</li>
              <li><strong>Comunicaciones del servicio:</strong> notificaciones relacionadas con la cuenta (alertas de inicio de sesión, aviso de expiración de plan, confirmación de exportaciones).</li>
              <li><strong>Seguridad:</strong> detección y prevención de accesos no autorizados, fraudes y abusos.</li>
              <li><strong>Mejora del servicio:</strong> análisis agregado y anónimo del uso de la plataforma para mejorar las funcionalidades.</li>
              <li><strong>Obligaciones legales:</strong> cumplimiento de requerimientos legales aplicables.</li>
            </ul>
          </Section>

          <Section title="4. Base jurídica del tratamiento">
            <ul>
              <li><strong>Ejecución del contrato:</strong> el tratamiento de datos de cuenta y operaciones es necesario para prestar el Servicio contratado.</li>
              <li><strong>Interés legítimo:</strong> el envío de avisos de seguridad (alertas de inicio de sesión) y la prevención de fraude se basan en el interés legítimo de {COMPANY} y del usuario.</li>
              <li><strong>Consentimiento:</strong> el envío de comunicaciones de marketing, si las hubiera, se realiza únicamente con consentimiento expreso.</li>
              <li><strong>Obligación legal:</strong> para cumplir con requerimientos legales o fiscales.</li>
            </ul>
          </Section>

          <Section title="5. Conservación de los datos">
            <p>
              Los datos de la cuenta se conservan mientras la cuenta permanezca activa. Tras la eliminación
              de la cuenta, los datos se borran de forma definitiva en un plazo de <strong>30 días</strong>,
              salvo que exista obligación legal de conservarlos por un período mayor.
            </p>
            <p>
              Los registros de seguridad y logs de acceso se conservan durante un máximo de <strong>90 días</strong>.
            </p>
          </Section>

          <Section title="6. Transferencias internacionales">
            <p>
              Los datos se almacenan en servidores de <strong>Vercel</strong> (infraestructura en la Unión
              Europea) y <strong>Neon</strong> (base de datos PostgreSQL). Ambos proveedores ofrecen garantías
              adecuadas conforme al RGPD mediante cláusulas contractuales tipo y certificaciones reconocidas.
            </p>
            <p>
              Las comunicaciones por email se procesan a través de <strong>Resend</strong> (proveedor de email
              transaccional). Consulte su política de privacidad para detalles sobre su tratamiento de datos.
            </p>
          </Section>

          <Section title="7. Sus derechos">
            <p>
              En virtud del Reglamento General de Protección de Datos (RGPD) y la Ley Orgánica de Protección
              de Datos (LOPDGDD), tiene los siguientes derechos:
            </p>
            <ul>
              <li><strong>Acceso:</strong> conocer qué datos personales tratamos sobre usted.</li>
              <li><strong>Rectificación:</strong> corregir datos inexactos o incompletos.</li>
              <li><strong>Supresión («derecho al olvido»):</strong> solicitar la eliminación de sus datos cuando no sean necesarios para la finalidad para la que fueron recogidos.</li>
              <li><strong>Oposición:</strong> oponerse al tratamiento basado en interés legítimo.</li>
              <li><strong>Limitación:</strong> solicitar la suspensión del tratamiento en determinados supuestos.</li>
              <li><strong>Portabilidad:</strong> recibir sus datos en formato estructurado y legible por máquina (disponible a través de la función «Exportar CSV» del Servicio).</li>
              <li><strong>Retirada del consentimiento:</strong> retirar en cualquier momento el consentimiento prestado, sin que ello afecte a la licitud del tratamiento anterior.</li>
            </ul>
            <p>
              Para ejercer cualquiera de estos derechos, contacte en{' '}
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. Responderemos en un plazo máximo de
              30 días. Asimismo, tiene derecho a presentar una reclamación ante la <strong>Agencia Española
              de Protección de Datos</strong> (AEPD) en <a href="https://www.aepd.es" target="_blank" rel="noopener noreferrer">www.aepd.es</a>.
            </p>
          </Section>

          <Section title="8. Seguridad">
            <p>
              Adoptamos medidas técnicas y organizativas razonables para proteger sus datos, incluyendo:
            </p>
            <ul>
              <li>Transmisión cifrada mediante HTTPS/TLS.</li>
              <li>Contraseñas almacenadas con hash bcrypt (no reversible).</li>
              <li>Acceso a los datos restringido al personal estrictamente necesario.</li>
              <li>Backups periódicos de la base de datos.</li>
            </ul>
            <p>
              Ningún sistema es completamente seguro. En caso de brecha de seguridad que afecte a sus datos,
              se lo notificaremos conforme a la normativa aplicable.
            </p>
          </Section>

          <Section title="9. Cookies y tecnologías similares">
            <p>
              El Servicio utiliza cookies de sesión estrictamente necesarias para el funcionamiento de la
              autenticación. No utilizamos cookies de seguimiento, publicidad o análisis de terceros.
            </p>
            <p>
              Las preferencias de tema (claro/oscuro) se almacenan en el <em>localStorage</em> del navegador
              y no se transmiten a nuestros servidores.
            </p>
          </Section>

          <Section title="10. Bot de Telegram (FidesBot)">
            <p>
              La integración con FidesBot requiere que el usuario inicie voluntariamente la conversación con
              el bot. Recopilamos el <em>Telegram ID</em> y el nombre de usuario de Telegram únicamente para
              vincular la cuenta y permitir el registro de operaciones. Estos datos se eliminan si el usuario
              desvincula su cuenta desde la configuración.
            </p>
            <p>
              FidesBot no almacena el contenido de los mensajes de Telegram más allá del procesamiento
              necesario para ejecutar las funcionalidades del servicio.
            </p>
          </Section>

          <Section title="11. Cambios en esta política">
            <p>
              Podemos actualizar esta Política de Privacidad para reflejar cambios en el Servicio o en la
              normativa aplicable. Los cambios significativos se notificarán por email o mediante aviso en
              la plataforma. La fecha de última actualización aparece en la parte superior de este documento.
            </p>
          </Section>

          <Section title="12. Contacto">
            <p>
              Para cualquier consulta sobre privacidad o protección de datos:{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>
            </p>
          </Section>

        </div>

        <div className="mt-12 pt-6 border-t flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>© 2026 {APP_NAME}</span>
          <nav className="flex gap-4">
            <Link href="/terms"   className="hover:text-foreground transition-colors">Términos de uso</Link>
            <Link href="/privacy" className="hover:text-foreground transition-colors font-medium">Privacidad</Link>
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
      <div className="space-y-2 text-sm text-foreground/90 leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_h4]:font-semibold [&_h4]:text-sm [&_a]:text-primary [&_a:hover]:underline">
        {children}
      </div>
    </section>
  )
}
