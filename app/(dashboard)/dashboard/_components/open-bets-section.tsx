'use client'

import { useState } from 'react'
import type { OpenBetItem } from '@/lib/queries/dashboard'
import { SettleButton } from '@/app/(dashboard)/records/_components/settle-button'
import { formatCurrency, formatDate } from '@/lib/utils/format'
import type { BetType } from '@/types/domain'

const BET_TYPE_META: Record<BetType, { label: string; emoji: string; cls: string }> = {
  ARBITRAGE: { label: 'Surebets',  emoji: '⚡', cls: 'bg-indigo-100 text-indigo-700 border border-indigo-200' },
  MIDDLE:    { label: 'Middlebet', emoji: '🎯', cls: 'bg-violet-100 text-violet-700 border border-violet-200' },
  SINGLE:    { label: 'Single',    emoji: '⚽', cls: 'bg-blue-100 text-blue-700 border border-blue-200'       },
  COMBO:     { label: 'Combo',     emoji: '📋', cls: 'bg-orange-100 text-orange-700 border border-orange-200' },
  CASINO:    { label: 'Casino',    emoji: '🎰', cls: 'bg-pink-100 text-pink-700 border border-pink-200'       },
  CUSTOM:    { label: 'Custom',    emoji: '📝', cls: 'bg-gray-100 text-gray-700 border border-gray-200'       },
}

interface Props {
  bets: OpenBetItem[]
}

export function OpenBetsSection({ bets }: Props) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const visible = bets.filter((b) => !dismissed.has(b.id))

  const totalStake = visible.reduce((sum, b) => sum + b.totalStake, 0)
  const totalGuaranteed = visible
    .filter((b) => b.type === 'ARBITRAGE' && b.potentialReturn !== null)
    .reduce((sum, b) => sum + (b.potentialReturn! - b.totalStake), 0)

  if (visible.length === 0) return null

  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-800/40 bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800/40">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
          <span className="text-xs font-medium text-amber-700 dark:text-amber-400 truncate">
            {visible.length === 1 ? '1 operación en juego' : `${visible.length} operaciones en juego`}
            {' '}·{' '}
            <span className="tabular-nums">{formatCurrency(totalStake)}</span> en riesgo
            {totalGuaranteed > 0 && (
              <span className="ml-1.5 text-green-700 dark:text-green-400 font-semibold">
                · ~+{formatCurrency(totalGuaranteed)} garantizados
              </span>
            )}
          </span>
        </div>
        <a
          href="/records"
          className="text-xs text-amber-600 dark:text-amber-400 hover:underline font-medium flex-shrink-0 ml-3"
        >
          Ver todas →
        </a>
      </div>

      {/* Rows */}
      <div className="divide-y">
        {visible.map((bet) => {
          const typeMeta = BET_TYPE_META[bet.type]
          const bookmakerLabel =
            bet.legs.length > 0
              ? bet.legs.map((l) => l.bookmakerName).join(' + ')
              : (bet.primaryBookmaker?.name ?? '—')
          const expectedProfit = bet.type === 'ARBITRAGE' && bet.potentialReturn !== null
            ? bet.potentialReturn - bet.totalStake
            : null

          const betForSettle = {
            id:                 bet.id,
            type:               bet.type,
            totalStake:         bet.totalStake,
            potentialReturn:    bet.potentialReturn ?? 0,
            primaryBookmakerId: bet.primaryBookmakerId,
            singleOdds:         bet.singleOdds,
            legs:               bet.legs,
          }

          return (
            <div key={bet.id} className="flex items-center gap-4 px-5 py-3.5">
              <span
                className={`hidden sm:inline-flex items-center gap-1 text-xs font-medium rounded-full px-2.5 py-1 flex-shrink-0 ${typeMeta.cls}`}
              >
                <span aria-hidden="true">{typeMeta.emoji}</span>
                <span>{typeMeta.label}</span>
              </span>
              <span className="sm:hidden text-base flex-shrink-0" aria-hidden="true">
                {typeMeta.emoji}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">
                  {bet.title ?? bet.eventName ?? 'Sin título'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {bookmakerLabel} · {formatDate(bet.datePlaced)}
                </p>
              </div>

              <div className="flex items-center gap-3 flex-shrink-0">
                <div className="text-right">
                  {expectedProfit !== null ? (
                    <>
                      <p className="text-sm font-semibold tabular-nums text-green-600 dark:text-green-400">
                        ~+{formatCurrency(expectedProfit)}
                      </p>
                      <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
                        {formatCurrency(bet.totalStake)} stake
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-semibold tabular-nums">
                        {formatCurrency(bet.totalStake)}
                      </p>
                      <span className="inline-block text-[10px] font-medium rounded-full px-2 py-0.5 mt-0.5 bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800/50">
                        en juego
                      </span>
                    </>
                  )}
                </div>

                <SettleButton
                  bet={betForSettle}
                  onSettled={() => setDismissed((prev) => new Set([...prev, bet.id]))}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
