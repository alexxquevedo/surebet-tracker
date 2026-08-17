import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { verifyBotSecret } from '@/lib/bot/auth'

/**
 * GET /api/bot/odds?live=true|false&maxAge=300
 *
 * Returns recent ScannedOdds grouped by event, formatted for concurrent
 * ingestion alongside The Odds API.  The bot merges both sources to combine
 * Spanish bookmakers (VPS scraper) with international ones (Odds API).
 *
 * Auth: x-bot-secret header
 */

const SPORT_TO_ODDS_KEY: Record<string, string> = {
  FOOTBALL:   'soccer',
  TENNIS:     'tennis',
  BASKETBALL: 'basketball',
  BASEBALL:   'baseball_mlb',
  HOCKEY:     'icehockey_nhl',
  RUGBY:      'rugbyleague',
  CRICKET:    'cricket',
  GOLF:       'golf',
  MMA:        'mma',
  BOXING:     'boxing',
}

export async function GET(request: NextRequest) {
  if (!verifyBotSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sp      = request.nextUrl.searchParams
  const live    = sp.get('live') === 'true'
  const defaultMaxAge = live ? 60 : 300  // live odds stale after 60s; prematch after 5min
  const maxAge  = Math.min(parseInt(sp.get('maxAge') ?? String(defaultMaxAge), 10), 900)

  const since = new Date(Date.now() - maxAge * 1000)

  const rows = await prisma.scannedOdds.findMany({
    where: {
      scrapedAt: { gte: since },
      isLive: live,
    },
    orderBy: { scrapedAt: 'desc' },
    select: {
      bookmaker: true,
      sport:     true,
      eventKey:  true,
      eventName: true,
      league:    true,
      startTime: true,
      isLive:    true,
      market:    true,
      outcomes:  true,
    },
  })

  // Group by eventKey → collect all (bookmaker, market, outcomes) tuples
  const grouped = new Map<string, {
    eventKey:  string
    eventName: string
    sport:     string
    sportKey:  string
    isLive:    boolean
    startTime: string | null
    league:    string | null
    bookmakerOdds: Array<{ bookmaker: string; market: string; outcomes: unknown }>
  }>()

  for (const row of rows) {
    if (!grouped.has(row.eventKey)) {
      grouped.set(row.eventKey, {
        eventKey:      row.eventKey,
        eventName:     row.eventName,
        sport:         row.sport,
        sportKey:      SPORT_TO_ODDS_KEY[row.sport] ?? row.sport.toLowerCase(),
        isLive:        row.isLive,
        startTime:     row.startTime?.toISOString() ?? null,
        league:        row.league ?? null,
        bookmakerOdds: [],
      })
    }
    grouped.get(row.eventKey)!.bookmakerOdds.push({
      bookmaker: row.bookmaker,
      market:    row.market,
      outcomes:  row.outcomes,
    })
  }

  return NextResponse.json({ events: [...grouped.values()] })
}
