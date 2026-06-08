import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Términos de uso — DualStats Tracker' }

const LAST_UPDATED = '1 de junio de 2026'
const CONTACT_EMAIL = 'legal@surebettracker.pro'

export default function TermsPage() {
  return (
    <article className="prose prose-sm prose-gray max-w-none dark:prose-invert">
      <h1 className="text-2xl font-bold mb-1">Términos de uso</h1>
      <p className="text-sm text-muted-foreground mb-8">
        Última actualización: {LAST_UPDATED}
      </p>

      <Section title="1. Aceptación de los términos">
        <p>
          Al acceder o utilizar DualStats Tracker (el «Servicio»), aceptas quedar vinculado por
          estos Términos de uso y por nuestra{' '}
          <Link href="/privacy" className="underline">Política de privacidad</Link>. Si no estás de
          acuerdo con alguna de las condiciones aquí establecidas, no debes usar el Servicio.
        </p>
        <p>
          Nos reservamos el derecho a modificar estos términos en cualquier momento. Cuando lo
          hagamos, actualizaremos la fecha indicada arriba y, si el cambio es sustancial, te
          notificaremos por email.
        </p>
      </Section>

      <Section title="2. Descripción del Servicio">
        <p>
          DualStats Tracker es una aplicación web de software como servicio (SaaS) diseñada para
          ayudar a usuarios individuales a registrar, organizar y analizar sus operaciones de
          apuestas deportivas (surebets, middles, apuestas simples y similares). El Servicio
          proporciona herramientas de seguimiento de bankroll, gestión de casas de apuestas e
          informes estadísticos.
        </p>
        <p>
          El Servicio <strong>no</strong> actúa como operador de apuestas ni como intermediario
          financiero. Únicamente registra información que el usuario introduce manualmente.
        </p>
      </Section>

      <Section title="3. Elegibilidad">
        <p>
          Debes tener al menos <strong>18 años</strong> (o la edad mínima legal para participar en
          actividades de apuestas en tu jurisdicción, si fuera superior) para usar el Servicio.
          Al registrarte, declaras cumplir este requisito.
        </p>
        <p>
          El Servicio está disponible únicamente en las jurisdicciones donde su uso es legal. Es
          responsabilidad del usuario asegurarse de que el uso del Servicio cumple con la
          legislación local aplicable.
        </p>
      </Section>

      <Section title="4. Registro de cuenta">
        <p>
          Debes crear una cuenta para acceder al Servicio. Eres responsable de mantener la
          confidencialidad de tus credenciales de acceso y de todas las actividades que ocurran
          bajo tu cuenta. Notifícanos inmediatamente si sospechas de acceso no autorizado a tu
          cuenta.
        </p>
        <p>
          Nos reservamos el derecho a suspender o eliminar cuentas que violen estos términos o
          que sean utilizadas de forma fraudulenta.
        </p>
      </Section>

      <Section title="5. Suscripción y pagos">
        <p>
          El Servicio ofrece un plan gratuito (Free) y planes de pago (Pro, Enterprise). Los
          pagos se gestionan a través de{' '}
          <strong>Stripe</strong>, una pasarela de pago de terceros con certificación PCI-DSS.
          Nunca almacenamos datos de tarjeta de crédito en nuestros servidores.
        </p>
        <p>
          Las suscripciones se renuevan automáticamente al final de cada periodo de facturación.
          Puedes cancelar en cualquier momento desde la configuración de tu cuenta; el acceso se
          mantendrá hasta el final del periodo ya abonado. No se realizan reembolsos por periodos
          parciales, salvo que la ley aplicable lo exija.
        </p>
      </Section>

      <Section title="6. Uso aceptable">
        <p>Te comprometes a no:</p>
        <ul>
          <li>Usar el Servicio para actividades ilegales o fraudulentas.</li>
          <li>Intentar acceder a cuentas de otros usuarios o sistemas internos.</li>
          <li>Introducir datos falsos de forma sistemática con el fin de manipular los informes.</li>
          <li>Revender, sublicenciar o redistribuir el Servicio sin autorización escrita previa.</li>
          <li>Usar el Servicio de forma que cause daño a terceros o a la reputación de la plataforma.</li>
        </ul>
      </Section>

      <Section title="7. Aviso importante — Sin asesoramiento financiero">
        <p>
          El Servicio es una herramienta de <strong>seguimiento y organización personal</strong>.{' '}
          <strong>No proporciona consejo financiero, de inversión ni de apuestas</strong>. Toda
          la información generada (estadísticas, gráficos, informes de rentabilidad, etc.) tiene
          un propósito meramente informativo y retrospectivo.
        </p>
        <p>
          Las apuestas deportivas implican riesgo de pérdida económica. Si tienes problemas
          relacionados con el juego, consulta los recursos de ayuda disponibles en tu país
          (ej.{' '}
          <a
            href="https://www.jugarbien.es"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            jugarbien.es
          </a>{' '}
          en España).
        </p>
      </Section>

      <Section title="8. Propiedad de los datos">
        <p>
          Eres el <strong>propietario de todos los datos</strong> que introduces en el Servicio.
          No reclamamos ningún derecho sobre tus registros de apuestas, datos financieros ni
          información personal más allá de lo necesario para prestar el Servicio.
        </p>
        <p>
          Puedes exportar tus datos o solicitar su eliminación en cualquier momento. Si eliminas
          tu cuenta, todos tus datos serán borrados de forma permanente e irrecuperable de
          nuestros sistemas en un plazo máximo de 30 días.
        </p>
      </Section>

      <Section title="9. Disponibilidad del Servicio">
        <p>
          Nos esforzamos por mantener el Servicio disponible de forma continua, pero no
          garantizamos una disponibilidad del 100%. Podemos interrumpir el Servicio temporalmente
          por mantenimiento, actualizaciones o circunstancias fuera de nuestro control. No seremos
          responsables de las interrupciones del Servicio.
        </p>
      </Section>

      <Section title="10. Limitación de responsabilidad">
        <p>
          En la máxima medida permitida por la ley, DualStats Tracker no será responsable de
          ningún daño indirecto, incidental, especial o consecuente derivado del uso o la
          imposibilidad de uso del Servicio, incluyendo pérdidas económicas derivadas de
          decisiones de apuestas tomadas con base en la información mostrada en la plataforma.
        </p>
        <p>
          Nuestra responsabilidad total acumulada ante el usuario no superará el importe abonado
          por el Servicio en los últimos 3 meses.
        </p>
      </Section>

      <Section title="11. Resolución de cuenta">
        <p>
          Puedes eliminar tu cuenta en cualquier momento desde{' '}
          <Link href="/settings" className="underline">Configuración → Zona de peligro</Link>. También
          podemos suspender o cancelar tu acceso si incumples estos términos, con o sin previo
          aviso dependiendo de la gravedad del incumplimiento.
        </p>
      </Section>

      <Section title="12. Legislación aplicable">
        <p>
          Estos términos se rigen por la legislación española. Para cualquier controversia, las
          partes se someten a la jurisdicción de los tribunales de Madrid, España, salvo que la
          normativa de protección de consumidores de tu país de residencia establezca lo contrario.
        </p>
      </Section>

      <Section title="13. Contacto">
        <p>
          Para cualquier consulta sobre estos Términos de uso, escríbenos a:{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>
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
