'use client'

import { useState } from 'react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts'
import { useDarkMode } from '@/lib/hooks/use-dark-mode'
import type { BalancePoint } from '@/lib/queries/dashboard'

interface Props {
  data:           BalancePoint[]
  initialCapital: number
}

const PERIODS = [
  { label: '30d',  days: 30 },
  { label: '60d',  days: 60 },
  { label: '90d',  days: 90 },
  { label: 'Todo', days: Infinity },
] as const

function fmtBalance(v: number): string {
  if (Math.abs(v) >= 1000)
    return `${(v / 1000).toFixed(1)}k€`
  return `${v.toFixed(0)}€`
}

export function BankrollEvolutionChart({ data, initialCapital }: Props) {
  const dark = useDarkMode()
  const [period, setPeriod]       = useState<number>(90)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo,   setCustomTo]   = useState('')
  const [appliedFrom, setAppliedFrom] = useState('')
  const [appliedTo,   setAppliedTo]   = useState('')

  const isCustomActive = appliedFrom !== '' || appliedTo !== ''

  const filtered = (() => {
    if (isCustomActive) {
      return data.filter((p) => {
        if (appliedFrom && p.dateISO < appliedFrom) return false
        if (appliedTo   && p.dateISO > appliedTo)   return false
        return true
      })
    }
    return period === Infinity ? data : data.slice(-period)
  })()

  function applyCustomRange() {
    setAppliedFrom(customFrom)
    setAppliedTo(customTo)
  }

  function clearCustomRange() {
    setCustomFrom('')
    setCustomTo('')
    setAppliedFrom('')
    setAppliedTo('')
  }

  const lastBalance = filtered.length > 0 ? (filtered[filtered.length - 1]?.balance ?? initialCapital) : initialCapital
  const isPositive  = lastBalance >= initialCapital

  const strokeColor = isPositive ? '#16a34a' : '#dc2626'
  const gridColor   = dark ? '#374151' : '#f0f0f0'
  const tickColor   = dark ? '#9ca3af' : '#6b7280'
  const tooltipBg   = dark ? '#1f2937' : '#ffffff'
  const tooltipBdr  = dark ? '#374151' : '#e5e7eb'
  const refColor    = dark ? '#4b5563' : '#d1d5db'

  if (data.length === 0) {
    return (
      <div className="flex h-52 items-center justify-center">
        <p className="text-sm text-muted-foreground text-center">
          El gráfico aparecerá cuando haya operaciones liquidadas
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Controles: período + rango personalizado */}
      <div className="flex flex-wrap items-center gap-2 justify-end">
        {/* Botones de período predefinido */}
        <div className="flex gap-1">
          {PERIODS.map(({ label, days }) => (
            <button
              key={label}
              onClick={() => { setPeriod(days); clearCustomRange() }}
              className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors ${
                !isCustomActive && period === days
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Separador visual */}
        <span className="text-muted-foreground/40 text-xs hidden sm:inline">|</span>

        {/* Date range picker */}
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="text-xs px-2 py-1 rounded-md border border-input bg-background text-foreground w-[120px]"
            placeholder="Desde"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="text-xs px-2 py-1 rounded-md border border-input bg-background text-foreground w-[120px]"
            placeholder="Hasta"
          />
          <button
            onClick={applyCustomRange}
            disabled={!customFrom && !customTo}
            className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors ${
              isCustomActive
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
          >
            {isCustomActive ? '✓' : 'Ir'}
          </button>
          {isCustomActive && (
            <button
              onClick={clearCustomRange}
              className="px-2 py-1 text-xs rounded-md font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Limpiar rango"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={230}>
        <AreaChart data={filtered} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={strokeColor} stopOpacity={0.22} />
              <stop offset="95%" stopColor={strokeColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: tickColor }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 11, fill: tickColor }}
            tickLine={false}
            axisLine={false}
            width={54}
            tickFormatter={fmtBalance}
            domain={['auto', 'auto']}
          />
          <Tooltip
            formatter={(value: number, name: string) => [
              value.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }),
              name === 'balance' ? 'Balance' : 'P&L acumulado',
            ]}
            contentStyle={{
              fontSize: 12,
              borderRadius: 8,
              border: `1px solid ${tooltipBdr}`,
              backgroundColor: tooltipBg,
              color: dark ? '#f9fafb' : '#111827',
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            }}
            labelStyle={{ fontWeight: 600, marginBottom: 4 }}
          />
          {initialCapital > 0 && (
            <ReferenceLine
              y={initialCapital}
              stroke={refColor}
              strokeDasharray="4 4"
            />
          )}
          <Area
            type="monotone"
            dataKey="balance"
            stroke={strokeColor}
            strokeWidth={2.5}
            fill="url(#balGrad)"
            dot={false}
            activeDot={{ r: 5, strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>

      {/* Leyenda de la línea punteada */}
      {initialCapital > 0 && (
        <p className="text-[10px] text-muted-foreground text-right">
          ─ ─ Capital inicial:{' '}
          {initialCapital.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
        </p>
      )}
    </div>
  )
}
