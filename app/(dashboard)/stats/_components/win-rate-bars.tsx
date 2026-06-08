'use client'

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'
import { useDarkMode } from '@/lib/hooks/use-dark-mode'
import type { CategoryStat } from '@/lib/queries/stats'

interface Props {
  data:  CategoryStat[]
  label: string
}

export function WinRateBars({ data, label }: Props) {
  const dark = useDarkMode()
  const gridColor   = dark ? '#374151' : '#f0f0f0'
  const tickColor   = dark ? '#9ca3af' : '#6b7280'
  const tooltipBg   = dark ? '#1f2937' : '#ffffff'
  const tooltipBdr  = dark ? '#374151' : '#e5e7eb'

  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center">
        <p className="text-sm text-muted-foreground">Sin datos suficientes (mín. 2 ops.)</p>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 40)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 60, left: 8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} horizontal={false} />
        <XAxis
          type="number"
          domain={[0, 100]}
          tickFormatter={(v: number) => `${v}%`}
          tick={{ fontSize: 10, fill: tickColor }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={90}
          tick={{ fontSize: 11, fill: tickColor }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          formatter={(value: number, name: string) => {
            if (name === 'winRate') return [`${value.toFixed(1)}%`, 'Win rate']
            return [value, name]
          }}
          labelFormatter={(label: string) => {
            const item = data.find((d) => d.name === label)
            return item ? `${label} — ${item.count} ops.` : label
          }}
          contentStyle={{
            fontSize: 12,
            borderRadius: 8,
            border: `1px solid ${tooltipBdr}`,
            backgroundColor: tooltipBg,
            color: dark ? '#f9fafb' : '#111827',
          }}
        />
        <ReferenceLine x={50} stroke={dark ? '#6b7280' : '#d1d5db'} strokeDasharray="4 4" />
        <Bar dataKey="winRate" radius={[0, 4, 4, 0]} maxBarSize={24} label={{ position: 'right', fontSize: 10, fill: tickColor, formatter: (v: number) => `${v.toFixed(0)}%` }}>
          {data.map((entry) => (
            <Cell
              key={entry.name}
              fill={entry.winRate >= 55 ? '#16a34a' : entry.winRate >= 45 ? '#d97706' : '#dc2626'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
