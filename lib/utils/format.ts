import { format, formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'

export function formatCurrency(
  amount: number,
  currency = 'EUR',
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...options,
  }).format(amount)
}

export function formatPercentage(value: number, decimals = 2): string {
  const formatted = value.toFixed(decimals)
  const sign = value > 0 ? '+' : ''
  return `${sign}${formatted}%`
}

export function formatRoi(roi: number): string {
  return formatPercentage(roi, 2)
}

export function formatDate(date: Date | string, pattern = 'dd/MM/yyyy'): string {
  return format(new Date(date), pattern, { locale: es })
}

export function formatDateTime(date: Date | string): string {
  return format(new Date(date), 'dd/MM/yyyy HH:mm', { locale: es })
}

export function formatRelativeTime(date: Date | string): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true, locale: es })
}

export function formatNumber(value: number, decimals = 0): string {
  return new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
}

export function formatOdds(odds: number): string {
  return odds.toFixed(2)
}

export function formatArbPercentage(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct.toFixed(4)}%`
}
