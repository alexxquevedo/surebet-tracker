import type { SportType } from '@/types/domain'

export const SPORTS: { value: SportType; label: string; emoji: string }[] = [
  { value: 'FOOTBALL', label: 'Fútbol', emoji: '⚽' },
  { value: 'TENNIS', label: 'Tenis', emoji: '🎾' },
  { value: 'BASKETBALL', label: 'Baloncesto', emoji: '🏀' },
  { value: 'BASEBALL', label: 'Béisbol', emoji: '⚾' },
  { value: 'HOCKEY', label: 'Hockey', emoji: '🏒' },
  { value: 'CRICKET', label: 'Cricket', emoji: '🏏' },
  { value: 'RUGBY', label: 'Rugby', emoji: '🏉' },
  { value: 'GOLF', label: 'Golf', emoji: '⛳' },
  { value: 'MMA', label: 'MMA', emoji: '🥊' },
  { value: 'BOXING', label: 'Boxeo', emoji: '🥊' },
  { value: 'CYCLING', label: 'Ciclismo', emoji: '🚴' },
  { value: 'MOTORSPORT', label: 'Motor', emoji: '🏎️' },
  { value: 'ESPORTS', label: 'eSports', emoji: '🎮' },
  { value: 'OTHER', label: 'Otros', emoji: '🏆' },
]

export const CURRENCIES = [
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'Libra esterlina' },
  { code: 'USD', symbol: '$', name: 'Dólar estadounidense' },
  { code: 'CHF', symbol: 'Fr', name: 'Franco suizo' },
  { code: 'SEK', symbol: 'kr', name: 'Corona sueca' },
  { code: 'NOK', symbol: 'kr', name: 'Corona noruega' },
  { code: 'DKK', symbol: 'kr', name: 'Corona danesa' },
]

export const CHART_PERIODS = [
  { value: '7d', label: '7 días' },
  { value: '30d', label: '30 días' },
  { value: '90d', label: '90 días' },
  { value: 'ytd', label: 'Este año' },
  { value: 'all', label: 'Todo' },
] as const

export type ChartPeriod = (typeof CHART_PERIODS)[number]['value']

export const BOOKMAKER_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#4f46e5',
]

export const PLAN_LIMITS = {
  FREE: { arbitrages: 100, bookmakers: 5 },
  PRO: { arbitrages: null, bookmakers: null },
  ENTERPRISE: { arbitrages: null, bookmakers: null },
} as const
