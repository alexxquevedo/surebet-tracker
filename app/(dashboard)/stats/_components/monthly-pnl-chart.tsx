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
  ReferenceLine,
} from 'recharts'
import type { MonthlyPnl } from '@/lib/queries/stats'
import { useDarkMode } from '@/lib/hooks/use-dark-mode'

interface Props {
  data: MonthlyPnl[]
}

export function MonthlyPnlChart({ data }: Props) {
  const dark = useDarkMode()
  const gridColor  = dark ? '#374151' : '#f0f0f0'
  const tickColor  = dark ? '#9ca3af' : '#6b7280'
  const tooltipBg  = dark ? '#1f2937' : '#ffffff'
  const tooltipBdr = dark ? '#374151' : '#e5e7eb'

  // Only show months if there's at least one with data
  const hasData = data.some((d) => d.count > 0)

  if (!hasData) {
    return (
      <div className="flex h-40 items-center justify-center">
        <p className="text-sm text-muted-foreground">Sin operaciones liquidadas todavía</p>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <ReferenceLine y={0} stroke={dark ? '#6b7280' : '#9ca3af'} strokeWidth={1} />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 10, fill: tickColor }}
          tickLine={false}
          axisLine={false}
          interval={0}
          angle={-90}
          textAnchor="end"
          height={52}
        />
        <YAxis
          tick={{ fontSize: 11, fill: tickColor }}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}€`}
        />
        <Tooltip
          formatter={(value: number, _name: string, props: { payload?: { count?: number } }) => [
            `${value >= 0 ? '+' : ''}${value.toFixed(2)} €`,
            `P&L · ${props.payload?.count ?? 0} op${(props.payload?.count ?? 0) !== 1 ? 's' : ''}.`,
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
        <Bar dataKey="profit" radius={[3, 3, 0, 0]} maxBarSize={48}>
          {data.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={entry.profit >= 0 ? '#16a34a' : '#dc2626'}
              opacity={entry.count === 0 ? 0 : entry.profit < 0 ? 0.7 : 1}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
