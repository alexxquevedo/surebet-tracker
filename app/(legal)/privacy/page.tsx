import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Política de privacidad — DualStats Tracker' }

const LAST_UPDATED  = '1 de junio de 2026'
const CONTACT_EMAIL = 'privacidad@surebettracker.pro'
const DPO_EMAIL     = 'dpo@surebettracker.pro'

export default function PrivacyPage() {
  return (
    <article className="prose prose-sm prose-gray max-w-none dark:prose-invert">
      <h1 className="text-2xl font-bold mb-1">Política de privacidad</h1>
      <p className="text-sm text-muted-foreground mb-8">
        Última actualización: {LAST_UPDATED}
      </p>

      <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
        En DualStats Tracker nos comprometemos a proteger tu privacidad. Esta Política explica
        qué datos recogemos, cómo los usamos y qué derechos tienes sobre ellos. Si tienes
        alguna duda, escríbenos a{' '}
        <a href={`mailto:${CONTACT_EMAIL}`} className="underline text-foreground">
          {CONTACT_EMAIL}
        </a>.
      </p>

      <Section title="1. Responsable del tratamiento">
        <p>
          El responsable del tratamiento de tus datos personales es{' '}
          <strong>DualStats Tracker</strong> (en adelante, «nosotros» o «el Servicio»).
          Para ejercer tus derechos o consultas sobre privacidad, contacta con nuestro
          Delegado de Protección de Datos (DPO) en:{' '}
          <a href={`mailto:${DPO_EMAIL}`} className="underline">{DPO_EMAIL}</a>.
        </p>
      </Section>

      <Section title="2. Datos que recogemos">
        <p>Recogemos los siguientes tipos de datos:</p>
        <ul>
          <li>
            <strong>Datos de cuenta:</strong> nombre, dirección de email y contraseña (almacenada
            en formato hash bcrypt, nunca en texto plano). Si te registras con Google, recibimos
            únicamente el email, nombre e imagen de perfil proporcionados por Google.
          </li>
          <li>
            <strong>Registros de apuestas:</strong> toda la información que introduces manualmente:
            casas de apuestas, bankrolls, stakes, cuotas, resultados, títulos y notas.
          </li>
          <li>
            <strong>Preferencias:</strong> zona horaria, preferencias de notificaciones y
            configuración del panel de control.
          </li>
          <li>
            <strong>Datos de uso:</strong> fecha y hora del último inicio de sesión, dirección IP
            de acceso (para alertas de seguridad), uso de claves API.
          </li>
          <li>
            <strong>Datos de pago:</strong> gestionados exclusivamente por Stripe. Nosotros solo
            recibimos el identificador de cliente y el estado de la suscripción; nunca almacenamos
            datos de tarjeta de crédito.
          </li>
        </ul>
        <p>
          <strong>No recogemos</strong> datos de ubicación en tiempo real, datos biométricos ni
          información sobre las apuestas que hagas en las casas externas (solo la información que
          tú introduces voluntariamente).
        </p>
      </Section>

      <Section title="3. Finalidad y base legal del tratamiento">
        <p>Tratamos tus datos para las siguientes finalidades:</p>
        <ul>
          <li>
            <strong>Prestación del Servicio</strong> (base legal: ejecución del contrato) —
            crear y gestionar tu cuenta, almacenar tus registros de apuestas, generar informes.
          </li>
          <li>
            <strong>Comunicaciones transaccionales</strong> (base legal: interés legítimo) —
            alertas de seguridad (nuevo inicio de sesión), confirmaciones de liquidación de
            apuestas, actualizaciones de la plataforma.
          </li>
          <li>
            <strong>Facturación</strong> (base legal: obligación legal y ejecución del contrato) —
            gestión de suscripciones y pagos a través de Stripe.
          </li>
          <li>
            <strong>Seguridad y prevención de fraude</strong> (base legal: interés legítimo) —
            detección de accesos no autorizados, auditoría de operaciones internas.
          </li>
        </ul>
      </Section>

      <Section title="4. Almacenamiento y seguridad de los datos">
        <p>
          Tus datos se almacenan en servidores de{' '}
          <strong>Supabase</strong> ubicados en la región{' '}
          <strong>EU West (Irlanda)</strong>, dentro del Espacio Económico Europeo.
          Supabase cumple con el RGPD y la normativa de privacidad aplicable.
        </p>
        <p>Las medidas de seguridad incluyen:</p>
        <ul>
          <li>Cifrado en tránsito mediante TLS 1.2+.</li>
          <li>Cifrado en reposo para la base de datos.</li>
          <li>Contraseñas almacenadas como hash bcrypt con sal aleatoria.</li>
          <li>Claves API almacenadas únicamente como hash SHA-256.</li>
          <li>Acceso a la base de datos restringido por roles con privilegios mínimos.</li>
        </ul>
      </Section>

      <Section title="5. Conservación de los datos">
        <p>
          Conservamos tus datos mientras tu cuenta esté activa o sea necesario para prestar el
          Servicio. Si eliminas tu cuenta, tus datos se borran de forma permanente de nuestros
          sistemas en un plazo máximo de <strong>30 días</strong>. Los registros de facturación
          se conservan durante el tiempo legalmente exigido (mínimo 5 años según la normativa
          fiscal española).
        </p>
      </Section>

      <Section title="6. Terceros y transferencias de datos">
        <p>
          <strong>No vendemos ni cedemos tus datos personales a terceros</strong> con fines
          comerciales o publicitarios. Únicamente compartimos datos con los siguientes proveedores
          de servicios esenciales, bajo acuerdos de procesamiento de datos que garantizan el
          cumplimiento del RGPD:
        </p>
        <ul>
          <li>
            <strong>Supabase</strong> — base de datos y almacenamiento (EU West).
          </li>
          <li>
            <strong>Stripe</strong> — procesamiento de pagos. Consulta su{' '}
            <a
              href="https://stripe.com/es/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Política de privacidad
            </a>.
          </li>
          <li>
            <strong>Resend</strong> — envío de emails transaccionales (alertas de seguridad,
            notificaciones). Solo reciben tu dirección de email y el contenido del mensaje.
          </li>
          <li>
            <strong>Vercel</strong> — infraestructura de hosting de la aplicación web.
          </li>
        </ul>
        <p>
          No realizamos transferencias internacionales de datos fuera del EEE salvo donde los
          proveedores cuenten con las salvaguardas adecuadas (Cláusulas Contractuales Tipo de la
          Comisión Europea o decisión de adecuación).
        </p>
      </Section>

      <Section title="7. Tus derechos (RGPD)">
        <p>
          Como usuario en el EEE, tienes los siguientes derechos sobre tus datos personales:
        </p>
        <ul>
          <li><strong>Acceso:</strong> obtener confirmación de qué datos tratamos sobre ti.</li>
          <li><strong>Rectificación:</strong> corregir datos inexactos o incompletos.</li>
          <li>
            <strong>Supresión («derecho al olvido»):</strong> solicitar el borrado de tus datos.
            Puedes hacerlo directamente desde{' '}
            <Link href="/settings" className="underline">Configuración → Zona de peligro</Link>.
          </li>
          <li>
            <strong>Portabilidad:</strong> recibir tus datos en formato estructurado y legible por
            máquina (CSV, JSON).
          </li>
          <li>
            <strong>Oposición:</strong> oponerte al tratamiento basado en interés legítimo.
          </li>
          <li>
            <strong>Limitación:</strong> solicitar que limitemos el tratamiento de tus datos en
            determinadas circunstancias.
          </li>
          <li>
            <strong>Retirada del consentimiento:</strong> cuando el tratamiento se base en tu
            consentimiento, puedes retirarlo en cualquier momento sin que ello afecte a la
            licitud del tratamiento previo.
          </li>
        </ul>
        <p>
          Para ejercer cualquiera de estos derechos, escríbenos a{' '}
          <a href={`mailto:${DPO_EMAIL}`} className="underline">{DPO_EMAIL}</a>. Responderemos
          en un plazo máximo de <strong>30 días</strong>. Si consideras que tus derechos no han
          sido atendidos, puedes presentar una reclamación ante la{' '}
          <a
            href="https://www.aepd.es"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Agencia Española de Protección de Datos (AEPD)
          </a>.
        </p>
      </Section>

      <Section title="8. Cookies y tecnologías similares">
        <p>
          El Servicio utiliza únicamente cookies técnicas y de sesión estrictamente necesarias:
        </p>
        <ul>
          <li>
            <strong>Cookie de sesión (NextAuth):</strong> token JWT cifrado que mantiene tu sesión
            autenticada. Se elimina al cerrar sesión o cuando expira (30 días).
          </li>
          <li>
            <strong>Cookie CSRF:</strong> protección contra ataques de falsificación de solicitudes
            entre sitios.
          </li>
        </ul>
        <p>
          No utilizamos cookies de seguimiento, analítica de terceros ni publicidad
          comportamental. No es necesario un banner de cookies porque todas las cookies que
          usamos son técnicamente necesarias para el funcionamiento del Servicio.
        </p>
      </Section>

      <Section title="9. Menores de edad">
        <p>
          El Servicio no está dirigido a personas menores de 18 años. No recopilamos
          intencionadamente datos personales de menores. Si tienes conocimiento de que un menor
          ha creado una cuenta, contacta con nosotros para proceder a su eliminación.
        </p>
      </Section>

      <Section title="10. Cambios en esta política">
        <p>
          Podemos actualizar esta Política de privacidad periódicamente. Cuando realicemos cambios
          sustanciales, te notificaremos por email y actualizaremos la fecha indicada al inicio.
          Te recomendamos revisar esta página de vez en cuando.
        </p>
      </Section>

      <Section title="11. Contacto">
        <p>
          Para cualquier consulta sobre privacidad o para ejercer tus derechos, contacta con
          nosotros en:{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">{CONTACT_EMAIL}</a>
        </p>
        <p>
          Para asuntos específicos sobre protección de datos:{' '}
          <a href={`mailto:${DPO_EMAIL}`} className="underline">{DPO_EMAIL}</a>
        </p>
      </Section>
    </article>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-3 text-foreground">{title}</h2>
      <div className="space-y-3 text-sm text-muted-foreground leading-relaxed [&_a]:text-foreground [&_strong]:text-foreground">
        {children}
      </div>
    </section>
  )
}
