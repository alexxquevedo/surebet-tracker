'use client'

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { useDarkMode } from '@/lib/hooks/use-dark-mode'
import type { DistributionItem } from '@/lib/queries/stats'

interface Props {
  data: DistributionItem[]
}

export function DistributionChart({ data }: Props) {
  const dark = useDarkMode()

  if (data.length === 0) {
    return (
      <div className="flex h-52 items-center justify-center">
        <p className="text-sm text-muted-foreground">Sin datos suficientes</p>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          dataKey="count"
          nameKey="label"
          cx="50%"
          cy="50%"
          outerRadius={80}
          strokeWidth={2}
          stroke={dark ? '#1f2937' : '#ffffff'}
        >
          {data.map((entry) => (
            <Cell key={entry.status} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value: number, name: string) => [value, name]}
          contentStyle={{
            fontSize: 12,
            borderRadius: 8,
            border: `1px solid ${dark ? '#374151' : '#e5e7eb'}`,
            backgroundColor: dark ? '#1f2937' : '#ffffff',
            color: dark ? '#f9fafb' : '#111827',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          }}
        />
        <Legend
          iconType="circle"
          iconSize={8}
          formatter={(value) => (
            <span style={{ fontSize: 11, color: dark ? '#9ca3af' : '#6b7280' }}>{value}</span>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}
