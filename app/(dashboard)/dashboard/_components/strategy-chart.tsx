'use client'

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts'
import type { TypeBreakdown } from '@/types/domain'
import { useDarkMode } from '@/lib/hooks/use-dark-mode'

interface Props {
  data: TypeBreakdown[]
}

const TYPE_LABELS: Record<string, string> = {
  ARBITRAGE: 'Arb.',
  MIDDLE:    'Middle',
  SINGLE:    'Single',
  COMBO:     'Combo',
  CASINO:    'Casino',
  CUSTOM:    'Custom',
}

const TYPE_COLORS: Record<string, string> = {
  ARBITRAGE: '#6366f1',
  MIDDLE:    '#8b5cf6',
  SINGLE:    '#3b82f6',
  COMBO:     '#f97316',
  CASINO:    '#ec4899',
  CUSTOM:    '#6b7280',
}

export function StrategyChart({ data }: Props) {
  const dark = useDarkMode()
  const gridColor  = dark ? '#374151' : '#f0f0f0'
  const tickColor  = dark ? '#9ca3af' : '#6b7280'
  const tooltipBg  = dark ? '#1f2937' : '#ffffff'
  const tooltipBdr = dark ? '#374151' : '#e5e7eb'

  if (data.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center">
        <p className="text-sm text-muted-foreground">Sin operaciones registradas</p>
      </div>
    )
  }

  const chartData = data.map((d) => ({
    ...d,
    label: TYPE_LABELS[d.type] ?? d.type,
    color: TYPE_COLORS[d.type] ?? '#6b7280',
  }))

  return (
    <ResponsiveContainer width="100%" height={170}>
      <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: tickColor }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: tickColor }}
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}€`}
        />
        <Tooltip
          formatter={(value: number) => [
            `${value >= 0 ? '+' : ''}${value.toFixed(2)}€`,
            'P&L neto',
          ]}
          contentStyle={{
            fontSize: 12,
            borderRadius: 8,
            border: `1px solid ${tooltipBdr}`,
            backgroundColor: tooltipBg,
            color: dark ? '#f9fafb' : '#111827',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          }}
          cursor={{ fill: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }}
        />
        <Bar dataKey="profit" radius={[4, 4, 0, 0]} maxBarSize={60}>
          {chartData.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={entry.color}
              opacity={entry.profit < 0 ? 0.65 : 1}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
