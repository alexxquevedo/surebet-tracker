'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { updateBetMetadataAction } from '@/lib/actions/bet-record'
import type { SerializedRecord } from './records-section'

const SPORTS = [
  { value: 'FOOTBALL',   label: '⚽ Fútbol'      },
  { value: 'TENNIS',     label: '🎾 Tenis'        },
  { value: 'BASKETBALL', label: '🏀 Baloncesto'   },
  { value: 'BASEBALL',   label: '⚾ Béisbol'      },
  { value: 'HOCKEY',     label: '🏒 Hockey'       },
  { value: 'CRICKET',    label: '🏏 Cricket'      },
  { value: 'RUGBY',      label: '🏉 Rugby'        },
  { value: 'GOLF',       label: '⛳ Golf'          },
  { value: 'MMA',        label: '🥋 MMA'          },
  { value: 'BOXING',     label: '🥊 Boxeo'        },
  { value: 'CYCLING',    label: '🚴 Ciclismo'     },
  { value: 'MOTORSPORT', label: '🏎️ Motorsport'   },
  { value: 'ESPORTS',    label: '🎮 eSports'      },
  { value: 'OTHER',      label: '🎯 Otro'         },
]

function toDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

function localToUTC(datetimeLocal: string): string {
  const d = new Date(datetimeLocal)
  return isNaN(d.getTime()) ? datetimeLocal : d.toISOString()
}

interface Props {
  record: SerializedRecord
}

export function EditButton({ record: r }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
        title="Editar"
        aria-label="Editar apuesta"
      >
        ✏️
      </button>
      {open && <EditModal record={r} onClose={() => setOpen(false)} />}
    </>
  )
}

function EditModal({ record: r, onClose }: { record: SerializedRecord; onClose: () => void }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error,   setError]  = useState<string | null>(null)

  // Para combos, sport y competition viven en las selecciones, no en el record
  const derivedSport = r.sport
    ?? (r.type === 'COMBO' ? (r.comboDetail?.selections?.find(s => s.sport)?.sport ?? '') : '')
  const derivedCompetition = r.competition
    ?? (r.type === 'COMBO' ? (r.comboDetail?.selections?.find(s => s.competition)?.competition ?? '') : '')

  // Controlled state
  const [title,       setTitle]       = useState(r.title       ?? '')
  const [notes,       setNotes]       = useState(r.notes       ?? '')
  const [competition, setCompetition] = useState(derivedCompetition)
  const [eventName,   setEventName]   = useState(r.eventName   ?? '')
  const [sport,       setSport]       = useState(derivedSport)
  const [isLive,      setIsLive]      = useState(r.isLive)
  const [datePlaced,  setDatePlaced]  = useState(toDatetimeLocal(r.datePlaced))

  // Odds per leg (only for PLACED ARB/MIDDLE)
  const canEditOdds = r.status === 'PLACED' && ['ARBITRAGE', 'MIDDLE'].includes(r.type)
  const canEditSingleOdds = r.status === 'PLACED' && r.type === 'SINGLE'
  const [legOdds,    setLegOdds]    = useState<Record<string, string>>(
    Object.fromEntries(r.legs.map((l) => [l.id, l.odds.toFixed(2)]))
  )
  const [singleOdds, setSingleOdds] = useState(
    r.singleBetDetail?.odds != null ? String(r.singleBetDetail.odds) : ''
  )

  function handleSave() {
    setError(null)
    start(async () => {
      const legUpdates = canEditOdds
        ? r.legs.map((l) => ({ id: l.id, odds: parseFloat(legOdds[l.id] ?? String(l.odds)) })).filter((l) => !isNaN(l.odds))
        : undefined

      const res = await updateBetMetadataAction(r.id, {
        title:       title       || null,
        notes:       notes       || null,
        competition: competition || null,
        eventName:   eventName   || null,
        sport:       sport       || null,
        isLive,
        datePlaced: localToUTC(datePlaced),
        legUpdates,
        singleOdds:  canEditSingleOdds && singleOdds ? parseFloat(singleOdds) : undefined,
      })
      if (res.success) {
        router.refresh()
        onClose()
      } else {
        setError(res.error)
      }
    })
  }

  const bmLabel = (l: SerializedRecord['legs'][number]) =>
    l.bookmaker.etiqueta ? `${l.bookmaker.name} · ${l.bookmaker.etiqueta}` : l.bookmaker.name

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-card border rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-base font-semibold">Editar apuesta</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg border text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">

          {/* Título */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Título</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej: Barça vs Madrid — Over 2.5"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Sport + isLive */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Deporte</label>
              <select
                value={sport}
                onChange={(e) => setSport(e.target.value)}
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">— Sin deporte —</option>
                {SPORTS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Fecha y hora</label>
              <input
                type="datetime-local"
                value={datePlaced}
                onChange={(e) => setDatePlaced(e.target.value)}
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {/* Competición + Evento */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Competición</label>
              <input
                type="text"
                value={competition}
                onChange={(e) => setCompetition(e.target.value)}
                placeholder="La Liga, NBA…"
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Partido / Evento</label>
              <input
                type="text"
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                placeholder="Barça vs Madrid"
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {/* LIVE toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isLive}
              onChange={(e) => setIsLive(e.target.checked)}
              className="rounded border-muted-foreground/30"
            />
            <span className="text-sm">Apuesta LIVE</span>
          </label>

          {/* Cuotas por pierna (solo PLACED ARB/MIDDLE) */}
          {canEditOdds && r.legs.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Cuotas reales por casa</p>
              <div className="space-y-2">
                {r.legs.map((l) => (
                  <div key={l.id} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground min-w-0 flex-1 truncate">{bmLabel(l)}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={legOdds[l.id] ?? l.odds}
                      onChange={(e) => setLegOdds((prev) => ({ ...prev, [l.id]: e.target.value.replace(',', '.') }))}
                      className="w-24 rounded-lg border bg-background px-2.5 py-1.5 text-sm text-right font-mono outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cuota single (solo PLACED SINGLE) */}
          {canEditSingleOdds && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Cuota real</label>
              <input
                type="text"
                inputMode="decimal"
                value={singleOdds}
                onChange={(e) => setSingleOdds(e.target.value.replace(',', '.'))}
                className="w-32 rounded-lg border bg-background px-3 py-2 text-sm font-mono text-right outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}

          {/* Notas */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Notas</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Observaciones personales…"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm resize-none outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={pending}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {pending ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  )
}
