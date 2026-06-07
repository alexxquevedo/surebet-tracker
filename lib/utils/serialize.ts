/**
 * Convierte objetos Prisma.Decimal a números JavaScript.
 * OBLIGATORIO antes de pasar datos desde RSC a Client Components.
 *
 * Prisma devuelve objetos Decimal para campos Decimal(x,y).
 * Next.js no puede serializar estos objetos al cruzar el boundary RSC→Client.
 *
 * Uso:
 *   const data = await prisma.bookmaker.findMany(...)
 *   return serializePrisma(data) // seguro para pasar a Client Components
 */
export function serializePrisma<T>(data: T): T {
  return JSON.parse(
    JSON.stringify(data, (_key, value) => {
      // Detectar Prisma Decimal por su constructor name y método toString
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof value.toString === 'function' &&
        value.constructor?.name === 'Decimal'
      ) {
        return parseFloat(value.toString())
      }
      return value
    }),
  ) as T
}
