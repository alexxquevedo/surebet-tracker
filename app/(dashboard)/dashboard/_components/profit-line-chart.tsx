'use client'

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts'
import { useDarkMode } from '@/lib/hooks/use-dark-mode'

export interface ProfitPoint {
  date: string
  dailyProfit: number
  cumulative: number
}

interface Props {
  data: ProfitPoint[]
}

export function ProfitLineChart({ data }: Props) {
  const dark = useDarkMode()
  const gridColor  = dark ? '#374151' : '#f0f0f0'
  const tickColor  = dark ? '#9ca3af' : '#6b7280'
  const tooltipBg  = dark ? '#1f2937' : '#ffffff'
  const tooltipBdr = dark ? '#374151' : '#e5e7eb'
  const refLine    = dark ? '#4b5563' : '#e5e7eb'

  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Sin operaciones liquidadas aún — la gráfica aparecerá aquí
        </p>
      </div>
    )
  }

  const lastPoint = data[data.length - 1]
  const isPositive = (lastPoint?.cumulative ?? 0) >= 0

  return (
    <ResponsiveContainer width="100%" height={210}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis
          dataKey="date"
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
          formatter={(value: number, name: string) => {
            const label = name === 'cumulative' ? 'P&L acumulado' : 'P&L diario'
            return [`${value >= 0 ? '+' : ''}${value.toFixed(2)}€`, label]
          }}
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
        <ReferenceLine y={0} stroke={refLine} strokeDasharray="4 4" />
        <Line
          type="monotone"
          dataKey="cumulative"
          stroke={isPositive ? '#16a34a' : '#dc2626'}
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 5, strokeWidth: 0 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
