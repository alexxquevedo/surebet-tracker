'use client'

import React, { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { SettleButton, type LegInfo } from './settle-button'
import { DeleteButton } from './delete-button'
import { EditButton } from './edit-button'
import { moveBetsToBankrollAction } from '@/lib/actions/bet-record'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SerializedLeg {
  id: string
  bookmakerId: string
  stake: number
  odds: number
  potentialReturn: number
  bookmaker: { name: string; etiqueta: string | null }
}

export interface SerializedRecord {
  id: string
  type: string
  status: string
  sport: string | null
  isLive: boolean
  notes: string | null
  competition: string | null
  eventName: string | null
  totalStake: number
  grossProfit: number | null
  potentialReturn: number | null
  datePlaced: string
  eventDate: string | null
  dateSettled: string | null
  title: string | null
  primaryBookmakerId: string | null
  primaryBookmaker: { name: string; etiqueta: string | null; color: string | null } | null
  singleBetDetail: { selection: string | null; odds: number | null } | null
  arbitrageDetail: { winningLegId: string | null } | null
  middleDetail: { winningLegId: string | null; middleHit: boolean | null } | null
  comboDetail: {
    totalOdds: number
    legCount: number
    selections: Array<{ id: string; eventName: string | null; selection: string | null; sport: string | null; competition: string | null }>
  } | null
  legs: SerializedLeg[]
  bankrollId: string | null
  bankroll: { id: string; name: string; color: string | null } | null
  isApproximate: boolean
}

export interface BankrollOption {
  id: string
  name: string
  color: string | null
}

// ─── Labels ───────────────────────────────────────────────────────────────────

const BET_TYPE_LABEL: Record<string, string> = {
  ARBITRAGE: '⚡ Surebets',
  MIDDLE:    '🎯 Middlebet',
  SINGLE:    '⚽ Single',
  COMBO:     '📋 Combo',
  CASINO:    '🎰 Casino',
  CUSTOM:    '📝 Custom',
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  PLACED:      { label: 'En juego',  cls: 'bg-amber-100 text-amber-700 border border-amber-200'  },
  WON:         { label: 'Ganada',    cls: 'bg-green-100 text-green-700 border border-green-200'  },
  LOST:        { label: 'Perdida',   cls: 'bg-red-100 text-red-700 border border-red-200'        },
  VOID:        { label: 'Anulada',   cls: 'bg-gray-100 text-gray-600 border border-gray-200'     },
  CASHOUT:     { label: 'Cashout',   cls: 'bg-blue-100 text-blue-700 border border-blue-200'     },
  PARTIAL_WIN: { label: 'Parcial',   cls: 'bg-teal-100 text-teal-700 border border-teal-200'     },
}

const SPORT_LABEL: Record<string, string> = {
  FOOTBALL:   '⚽ Fútbol',
  BASKETBALL: '🏀 Baloncesto',
  TENNIS:     '🎾 Tenis',
  HOCKEY:     '🏒 Hockey Hielo',
  BASEBALL:   '⚾ Béisbol',
  RUGBY:      '🏉 Rugby',
  CRICKET:    '🏏 Cricket',
  GOLF:       '⛳ Golf',
  MMA:        '🥋 MMA',
  BOXING:     '🥊 Boxeo',
  MOTORSPORT: '🏎️ Motorsport',
  ESPORTS:    '🎮 eSports',
  OTHER:      '🎯 Otro',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bmLabel(bm: { name: string; etiqueta?: string | null } | null | undefined): string {
  if (!bm) return ''
  return bm.etiqueta ? `${bm.name} · ${bm.etiqueta}` : bm.name
}

function getCasaGanada(r: SerializedRecord): string | null {
  if (r.status === 'PLACED') return null
  if (r.type === 'ARBITRAGE' && r.arbitrageDetail?.winningLegId) {
    const leg = r.legs.find((l) => l.id === r.arbitrageDetail!.winningLegId)
    return leg ? bmLabel(leg.bookmaker) : null
  }
  if (r.type === 'MIDDLE') {
    if (r.middleDetail?.middleHit === true) return r.legs.map((l) => bmLabel(l.bookmaker)).join(' + ')
    if (r.middleDetail?.winningLegId) {
      const leg = r.legs.find((l) => l.id === r.middleDetail!.winningLegId)
      return leg ? bmLabel(leg.bookmaker) : null
    }
  }
  if (r.status === 'WON' || r.status === 'PARTIAL_WIN' || r.status === 'CASHOUT') {
    return r.primaryBookmaker ? bmLabel(r.primaryBookmaker) : null
  }
  return null
}

function buildSortUrl(key: string, current: string, params: Record<string, string>): string {
  const next = current === `${key}-desc` ? `${key}-asc` : `${key}-desc`
  const p    = new URLSearchParams(params)
  p.set('sort', next)
  return `/records?${p.toString()}`
}

function SortIcon({ col, current }: { col: string; current: string }) {
  if (current === `${col}-desc`) return <span className="ml-1 opacity-70">↓</span>
  if (current === `${col}-asc`)  return <span className="ml-1 opacity-70">↑</span>
  return <span className="ml-1 opacity-30">↕</span>
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  records: SerializedRecord[]
  bankrolls: BankrollOption[]
  tz: string
  filterSort: string
  filterParams: Record<string, string>
}

export function RecordsSection({ records, bankrolls, tz, filterSort, filterParams }: Props) {
  const router = useRouter()

  const [selected,       setSelected]       = useState<Set<string>>(new Set())
  const [bulkBankrollId, setBulkBankrollId] = useState<string>('__unchanged__')
  const [isPending,      startTransition]    = useTransition()
  const [bulkError,      setBulkError]       = useState<string | null>(null)
  const [expandedCombos, setExpandedCombos] = useState<Set<string>>(new Set())
  const [expandedNotes,  setExpandedNotes]  = useState<Set<string>>(new Set())

  function toggleNotes(id: string) {
    setExpandedNotes((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }

  function toggleCombo(id: string) {
    setExpandedCombos((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAll() { setSelected(new Set(records.map((r) => r.id))) }
  function clearAll()  { setSelected(new Set()); setBulkBankrollId('__unchanged__'); setBulkError(null) }

  function handleBulkMove() {
    if (bulkBankrollId === '__unchanged__') return
    const bankrollId = bulkBankrollId === '__none__' ? null : bulkBankrollId
    setBulkError(null)
    startTransition(async () => {
      const res = await moveBetsToBankrollAction([...selected], bankrollId)
      if (res.success) {
        clearAll()
        router.refresh()
      } else {
        setBulkError(res.error)
      }
    })
  }

  const allSelected = records.length > 0 && selected.size === records.length

  function handleClone(r: SerializedRecord) {
    const validTypes = ['SINGLE', 'CASINO', 'COMBO', 'ARBITRAGE', 'MIDDLE']
    const payload = {
      betType:     validTypes.includes(r.type) ? r.type : 'SINGLE',
      selection:   r.singleBetDetail?.selection ?? r.title ?? '',
      eventName:   r.eventName ?? '',
      sport:       r.sport ?? '',
      competition: r.competition ?? '',
      bm1Id:       r.primaryBookmakerId ?? r.legs[0]?.bookmakerId ?? '',
      bm2Id:       r.legs[1]?.bookmakerId ?? '',
      comboRows:   r.type === 'COMBO' && r.comboDetail
        ? r.comboDetail.selections.map((s) => ({
            description: s.selection   ?? '',
            eventName:   s.eventName   ?? '',
            sport:       s.sport       ?? '',
            competition: s.competition ?? '',
          }))
        : [{ description: '', eventName: '', sport: '', competition: '' }],
    }
    localStorage.setItem('clone_bet', JSON.stringify(payload))
    window.dispatchEvent(new CustomEvent('dualstats:clone_bet'))
  }

  return (
    <div className="relative">

      {/* ─── Tabla (escritorio) ─────────────────────────────────────────── */}
      {records.length > 0 && (
        <div className="hidden md:block rounded-xl border shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="px-3 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={allSelected ? clearAll : selectAll}
                    className="rounded border-muted-foreground/30 cursor-pointer"
                    aria-label="Seleccionar todas"
                  />
                </th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Tipo</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden md:table-cell">Selección</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden lg:table-cell">Casa</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Estado</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden lg:table-cell">Casa ganada</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                  <a href={buildSortUrl('stake', filterSort, filterParams)} className="hover:text-foreground transition-colors">
                    Stake<SortIcon col="stake" current={filterSort} />
                  </a>
                </th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                  <a href={buildSortUrl('profit', filterSort, filterParams)} className="hover:text-foreground transition-colors">
                    P&L<SortIcon col="profit" current={filterSort} />
                  </a>
                </th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide hidden sm:table-cell">
                  <a href={buildSortUrl('date', filterSort, filterParams)} className="hover:text-foreground transition-colors">
                    Fecha evento<SortIcon col="date" current={filterSort} />
                  </a>
                </th>
                <th className="px-4 py-3 text-xs uppercase tracking-wide"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {records.map((r) => {
                const profit    = r.grossProfit
                const profitCls = profit === null
                  ? 'text-muted-foreground'
                  : profit > 0 ? 'text-green-600 font-semibold' : profit < 0 ? 'text-red-600 font-semibold' : 'text-muted-foreground'

                const selText    = r.title ?? r.singleBetDetail?.selection ?? '—'
                const legNames   = r.legs.map((l) => bmLabel(l.bookmaker)).join(' + ')
                const houseLabel = r.legs.length > 0
                  ? legNames
                  : r.primaryBookmaker ? bmLabel(r.primaryBookmaker) : '—'

                const sm      = STATUS_META[r.status] ?? { label: r.status, cls: 'bg-gray-100 text-gray-600 border border-gray-200' }
                const dateObj = new Date(r.eventDate ?? r.datePlaced)
                const dateFmt = dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', timeZone: tz })
                const timeFmt = dateObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: tz })

                const betForSettle = {
                  id:                 r.id,
                  type:               r.type,
                  totalStake:         r.totalStake,
                  potentialReturn:    r.potentialReturn ?? 0,
                  primaryBookmakerId: r.primaryBookmakerId,
                  singleOdds:         r.singleBetDetail?.odds ?? null,
                  legs:               r.legs.map((l): LegInfo => ({
                    id:              l.id,
                    bookmakerId:     l.bookmakerId,
                    bookmakerName:   bmLabel(l.bookmaker),
                    stake:           l.stake,
                    odds:            l.odds,
                    potentialReturn: l.potentialReturn,
                  })),
                }

                const casaGanada = getCasaGanada(r)
                const isChecked  = selected.has(r.id)

                const isComboExpanded = r.type === 'COMBO' && expandedCombos.has(r.id)

                return (
                  <React.Fragment key={r.id}>
                  <tr
                    className={`hover:bg-muted/20 transition-colors group ${isChecked ? 'bg-primary/5' : ''}`}
                  >
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelect(r.id)}
                        className="rounded border-muted-foreground/30 cursor-pointer"
                        aria-label={`Seleccionar ${selText}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {r.isLive && (
                          <span className="text-xs font-bold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full leading-tight">
                            LIVE
                          </span>
                        )}
                        <span className="text-xs font-semibold">{BET_TYPE_LABEL[r.type] ?? r.type}</span>
                      </div>
                      {r.sport && (
                        <p className="text-xs text-muted-foreground mt-0.5">{SPORT_LABEL[r.sport] ?? r.sport}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell max-w-[200px]">
                      {r.type === 'COMBO' && r.comboDetail ? (
                        <button onClick={() => toggleCombo(r.id)} className="text-left w-full group/combo">
                          <span className="text-xs text-muted-foreground block">{selText}</span>
                          <span className="text-xs text-primary/70 font-medium group-hover/combo:text-primary transition-colors">
                            {isComboExpanded ? '▲ Ocultar' : `▼ ${r.comboDetail.selections.length} selecciones`}
                          </span>
                        </button>
                      ) : (
                        <>
                          <span className="text-xs text-muted-foreground truncate block">{selText}</span>
                          {r.eventName && (
                            <span className="text-[10px] text-muted-foreground/60 truncate block">{r.eventName}</span>
                          )}
                          {r.competition && (
                            <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full bg-muted border border-muted-foreground/20 text-muted-foreground/60 mt-0.5">
                              {r.competition}
                            </span>
                          )}
                          {r.legs.length > 0
                            ? <span className="text-xs font-mono text-muted-foreground">@{r.legs[0]!.odds.toFixed(2)}</span>
                            : r.singleBetDetail?.odds != null
                              ? <span className="text-xs font-mono text-muted-foreground">@{r.singleBetDetail.odds.toFixed(2)}</span>
                              : null
                          }
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <div className="flex items-center gap-1.5">
                        {r.primaryBookmaker?.color && r.legs.length === 0 && (
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.primaryBookmaker.color }} />
                        )}
                        <span className="text-xs">{houseLabel}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className={`inline-flex items-center text-xs font-semibold rounded-full px-2.5 py-0.5 ${sm.cls}`}>
                          {sm.label}
                        </span>
                        {r.isApproximate && (
                          <span className="inline-flex items-center text-[10px] font-medium rounded-full px-2 py-0.5 bg-yellow-50 text-yellow-700 border border-yellow-200 w-fit">
                            ⚠️ Aprox.
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {casaGanada ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-800 px-2 py-0.5 rounded-full">
                          🏆 {casaGanada}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {r.totalStake.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-xs ${profitCls}`}>
                      {profit === null
                        ? <span className="text-muted-foreground">{(r.potentialReturn ?? r.totalStake).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}</span>
                        : `${profit >= 0 ? '+' : ''}${profit.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`
                      }
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground hidden sm:table-cell">
                      <span className="block">{dateFmt}</span>
                      <span className="block text-muted-foreground/60">{timeFmt}</span>
                      {!r.eventDate && (
                        <span className="block text-[10px] text-muted-foreground/40">reg.</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleClone(r)}
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
                          title="Clonar apuesta"
                          aria-label="Clonar apuesta"
                        >
                          🔁
                        </button>
                        {r.notes && (
                          <button
                            onClick={() => toggleNotes(r.id)}
                            className={`text-xs px-1 transition-colors ${expandedNotes.has(r.id) ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                            title="Ver notas"
                            aria-label="Ver notas"
                          >
                            📝
                          </button>
                        )}
                        {r.status === 'PLACED' && (
                          <SettleButton bet={betForSettle} />
                        )}
                        <EditButton record={r} />
                        <DeleteButton betRecordId={r.id} />
                      </div>
                    </td>
                  </tr>
                  {isComboExpanded && r.comboDetail && (
                    <tr className="bg-muted/20">
                      <td />
                      <td colSpan={8} className="px-4 pb-3 pt-1">
                        <div className="rounded-lg border bg-background/80 p-3 space-y-1.5">
                          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Selecciones</p>
                          {r.comboDetail.selections.map((s, i) => (
                            <div key={s.id} className="flex items-start gap-2 text-xs">
                              <span className="text-muted-foreground/50 w-4 shrink-0 font-mono">{i + 1}.</span>
                              <div className="min-w-0">
                                <span className="font-medium">{s.eventName || s.selection || '—'}</span>
                                {(s.sport || s.competition) && (
                                  <span className="text-muted-foreground ml-1.5">
                                    {[s.sport ? (SPORT_LABEL[s.sport] ?? s.sport) : null, s.competition].filter(Boolean).join(' · ')}
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                  {expandedNotes.has(r.id) && r.notes && (
                    <tr className="bg-muted/10">
                      <td />
                      <td colSpan={8} className="px-4 pb-3 pt-1">
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap bg-background/80 border rounded-lg p-3">
                          {r.notes}
                        </p>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Tarjetas (móvil) ───────────────────────────────────────────── */}
      {records.length > 0 && (
        <div className="block md:hidden space-y-3">
          {records.map((r) => {
            const profit    = r.grossProfit
            const pnlCls    =
              profit === null
                ? 'text-muted-foreground'
                : profit > 0
                  ? 'text-green-600 font-bold'
                  : profit < 0
                    ? 'text-red-600 font-bold'
                    : 'text-muted-foreground'
            const selText       = r.title ?? r.singleBetDetail?.selection ?? '—'
            const legNames      = r.legs.map((l) => bmLabel(l.bookmaker)).join(' + ')
            const casaGanadaMob = getCasaGanada(r)
            const houseLabel    = r.legs.length > 0 ? legNames : (r.primaryBookmaker ? bmLabel(r.primaryBookmaker) : '—')
            const sm            = STATUS_META[r.status] ?? { label: r.status, cls: 'bg-gray-100 text-gray-600 border border-gray-200' }
            const dateObj       = new Date(r.eventDate ?? r.datePlaced)
            const dateFmt       = dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', timeZone: tz })
            const timeFmt       = dateObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: tz })

            const betForSettle = {
              id:                 r.id,
              type:               r.type,
              totalStake:         r.totalStake,
              potentialReturn:    r.potentialReturn ?? 0,
              primaryBookmakerId: r.primaryBookmakerId,
              singleOdds:         r.singleBetDetail?.odds ?? null,
              legs:               r.legs.map((l): LegInfo => ({
                id:              l.id,
                bookmakerId:     l.bookmakerId,
                bookmakerName:   bmLabel(l.bookmaker),
                stake:           l.stake,
                odds:            l.odds,
                potentialReturn: l.potentialReturn,
              })),
            }

            const isChecked = selected.has(r.id)

            return (
              <div
                key={r.id}
                className={`rounded-xl border bg-card shadow-sm overflow-hidden transition-colors ${isChecked ? 'ring-2 ring-primary border-primary/50' : ''}`}
              >
                {/* Cabecera: checkbox + tipo + estado */}
                <div
                  className="flex items-start justify-between gap-3 px-4 py-3 border-b bg-muted/20 min-h-[44px] cursor-pointer select-none"
                  onClick={() => toggleSelect(r.id)}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      readOnly
                      className="rounded border-muted-foreground/30 shrink-0 pointer-events-none"
                    />
                    {r.isLive && (
                      <span className="shrink-0 text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full leading-tight">
                        LIVE
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold leading-tight truncate">{selText}</p>
                      {r.eventName && (
                        <p className="text-[11px] text-muted-foreground/70 truncate">{r.eventName}</p>
                      )}
                      {r.competition && (
                        <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full bg-muted border border-muted-foreground/20 text-muted-foreground/60">
                          {r.competition}
                        </span>
                      )}
                      <p className="text-xs text-muted-foreground">{BET_TYPE_LABEL[r.type] ?? r.type}</p>
                    </div>
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <span className={`inline-flex items-center text-xs font-semibold rounded-full px-2.5 py-1 ${sm.cls}`}>
                      {sm.label}
                    </span>
                    {r.isApproximate && (
                      <span className="inline-flex items-center text-[10px] font-medium rounded-full px-2 py-0.5 bg-yellow-50 text-yellow-700 border border-yellow-200">
                        ⚠️ Aprox.
                      </span>
                    )}
                  </div>
                </div>

                {/* Cuerpo: casa · stake · cuota · P&L */}
                <div className="flex items-center justify-between gap-3 px-4 py-3 min-h-[44px]">
                  <div className="min-w-0 space-y-0.5 flex-1">
                    <p className="text-xs font-medium text-foreground truncate">{houseLabel}</p>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
                      <span className="font-mono">
                        {r.totalStake.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                      </span>
                      {r.legs.length > 0 ? (
                        <>
                          <span>·</span>
                          <span className="font-mono">@{r.legs[0]!.odds.toFixed(2)}</span>
                        </>
                      ) : r.singleBetDetail?.odds != null ? (
                        <>
                          <span>·</span>
                          <span className="font-mono">@{r.singleBetDetail.odds.toFixed(2)}</span>
                        </>
                      ) : null}
                      {r.sport && (
                        <>
                          <span>·</span>
                          <span>{SPORT_LABEL[r.sport] ?? r.sport}</span>
                        </>
                      )}
                    </div>
                    {casaGanadaMob && (
                      <p className="text-[11px] font-medium text-green-700 dark:text-green-400">
                        🏆 Casa ganada: {casaGanadaMob}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground/70">
                      {r.eventDate ? '🗓 ' : ''}{dateFmt} · {timeFmt}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`text-base tabular-nums ${pnlCls}`}>
                      {profit === null
                        ? (r.potentialReturn ?? r.totalStake).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })
                        : `${profit >= 0 ? '+' : ''}${profit.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`
                      }
                    </p>
                    {profit === null && (
                      <p className="text-[10px] text-muted-foreground">Potencial</p>
                    )}
                  </div>
                </div>

                {/* Selecciones de combo (expandible) */}
                {r.type === 'COMBO' && r.comboDetail && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleCombo(r.id) }}
                      className="w-full text-left px-4 py-2 border-t text-xs text-primary/70 hover:bg-muted/20 transition-colors font-medium"
                    >
                      {expandedCombos.has(r.id) ? '▲ Ocultar selecciones' : `▼ Ver ${r.comboDetail.selections.length} selecciones`}
                    </button>
                    {expandedCombos.has(r.id) && (
                      <div className="px-4 pb-3 bg-muted/10 space-y-1.5">
                        {r.comboDetail.selections.map((s, i) => (
                          <div key={s.id} className="flex items-start gap-2 text-xs">
                            <span className="text-muted-foreground/50 w-4 shrink-0 font-mono">{i + 1}.</span>
                            <div>
                              <span className="font-medium">{s.eventName || s.selection || '—'}</span>
                              {(s.sport || s.competition) && (
                                <span className="text-muted-foreground ml-1">
                                  · {[s.sport ? (SPORT_LABEL[s.sport] ?? s.sport) : null, s.competition].filter(Boolean).join(' · ')}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* Notas inline */}
                {r.notes && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleNotes(r.id) }}
                      className={`w-full text-left px-4 py-2 border-t text-xs transition-colors ${expandedNotes.has(r.id) ? 'text-foreground bg-muted/20' : 'text-muted-foreground hover:bg-muted/20'}`}
                    >
                      {expandedNotes.has(r.id) ? '▲ Ocultar notas' : '📝 Ver notas'}
                    </button>
                    {expandedNotes.has(r.id) && (
                      <div className="px-4 pb-3 bg-muted/10">
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap">{r.notes}</p>
                      </div>
                    )}
                  </>
                )}

                {/* Pie: acciones */}
                <div className="px-4 pb-3 border-t pt-2 bg-muted/10 flex items-center justify-between gap-2">
                  <div>
                    {r.status === 'PLACED' && (
                      <SettleButton bet={betForSettle} />
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleClone(r)}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
                      title="Clonar apuesta"
                      aria-label="Clonar apuesta"
                    >
                      🔁
                    </button>
                    <EditButton record={r} />
                    <DeleteButton betRecordId={r.id} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ─── Barra flotante de acciones masivas ─────────────────────────── */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-2xl border bg-popover shadow-2xl px-4 py-3 text-sm min-w-[320px] max-w-[95vw]">
          <span className="text-muted-foreground font-medium shrink-0 text-xs">
            {selected.size} selec.
          </span>
          <select
            value={bulkBankrollId}
            onChange={(e) => setBulkBankrollId(e.target.value)}
            className="flex-1 min-w-0 rounded-lg border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="__unchanged__">— Bankroll —</option>
            <option value="__none__">Sin bankroll</option>
            {bankrolls.map((bk) => (
              <option key={bk.id} value={bk.id}>{bk.name}</option>
            ))}
          </select>
          <button
            onClick={handleBulkMove}
            disabled={isPending || bulkBankrollId === '__unchanged__'}
            className="shrink-0 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? '…' : 'Mover'}
          </button>
          <button
            onClick={clearAll}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Cancelar selección"
          >
            ✕
          </button>
        </div>
      )}

      {bulkError && (
        <p className="text-xs text-red-600 mt-2 text-center">{bulkError}</p>
      )}
    </div>
  )
}
