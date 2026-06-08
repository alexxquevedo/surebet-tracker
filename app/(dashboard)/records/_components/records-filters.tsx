'use client'
import { useRouter, useSearchParams } from 'next/navigation'
import { useRef, useCallback } from 'react'
import Link from 'next/link'

const SPORT_LABEL: Record<string, string> = {
  FOOTBALL:   'Fútbol',
  BASKETBALL: 'Baloncesto',
  TENNIS:     'Tenis',
  HOCKEY:     'Hockey Hielo',
  BASEBALL:   'Béisbol',
  RUGBY:      'Rugby',
  CRICKET:    'Cricket',
  GOLF:       'Golf',
  MMA:        'MMA',
  BOXING:     'Boxeo',
  MOTORSPORT: 'Motorsport',
  ESPORTS:    'eSports',
  OTHER:      'Otro',
}

interface Bookmaker { id: string; name: string }

interface Props {
  bookmakers:    Bookmaker[]
  filterSport:   string | undefined
  filterBm:      string | undefined
  filterStatus:  string | undefined
  filterLive:    string | undefined
  filterFrom:    string | undefined
  filterTo:      string | undefined
}

export function RecordsFilters({
  bookmakers,
  filterSport,
  filterBm,
  filterStatus,
  filterLive,
  filterFrom,
  filterTo,
}: Props) {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const timerRef     = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const hasAnyFilter = !!(filterSport ?? filterBm ?? filterStatus ?? filterLive ?? filterFrom ?? filterTo)

  // Aplica un cambio de filtro con debounce de 300ms
  const applyFilter = useCallback((key: string, value: string) => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString())
      if (value) {
        params.set(key, value)
      } else {
        params.delete(key)
      }
      router.push(`/records?${params.toString()}`)
    }, 300)
  }, [router, searchParams])

  return (
    <div className="flex flex-wrap gap-3 items-end">

      {/* Momento */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Momento</label>
        <select
          defaultValue={filterLive ?? ''}
          onChange={(e) => applyFilter('live', e.target.value)}
          className="rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring min-w-[130px]"
        >
          <option value="">Live + Pre</option>
          <option value="false">📅 Pre-partido</option>
          <option value="true">⚡ Live</option>
        </select>
      </div>

      {/* Deporte */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Deporte</label>
        <select
          defaultValue={filterSport ?? ''}
          onChange={(e) => applyFilter('sport', e.target.value)}
          className="rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring min-w-[130px]"
        >
          <option value="">Todos los deportes</option>
          {Object.entries(SPORT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {/* Casa */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Casa</label>
        <select
          defaultValue={filterBm ?? ''}
          onChange={(e) => applyFilter('bm', e.target.value)}
          className="rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring min-w-[140px]"
        >
          <option value="">Todas las casas</option>
          {bookmakers.map((bm) => (
            <option key={bm.id} value={bm.id}>{bm.name}</option>
          ))}
        </select>
      </div>

      {/* Estado */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Estado</label>
        <select
          defaultValue={filterStatus ?? ''}
          onChange={(e) => applyFilter('status', e.target.value)}
          className="rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring min-w-[120px]"
        >
          <option value="">Todos</option>
          <option value="PLACED">En juego</option>
          <option value="WON">Ganada</option>
          <option value="LOST">Perdida</option>
          <option value="VOID">Anulada</option>
          <option value="CASHOUT">Cashout</option>
        </select>
      </div>

      {hasAnyFilter && (
        <Link
          href="/records"
          className="rounded-lg border px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          Limpiar todo
        </Link>
      )}
    </div>
  )
}
