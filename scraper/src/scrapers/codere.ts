/**
 * Codere España — NavigationService HTTP scraper (sin navegador).
 *
 * Codere usa su propia API REST en m.apuestas.codere.es/NavigationService.
 * La API es pública y no requiere autenticación ni proxy desde OVH.
 *
 * Live:    GET /Event/GetLiveEventsAndSportsBySportHandle?gametypes=
 *          → { Events: [{ Name, SportHandle, DefaultGame: { Results: [{ Name, Odd, SortOrder }] } }] }
 *
 * Prematch (por liga):
 *  1. GET /LeftMenu/GetCountriesAndHighlights?parentid={sportNodeId}
 *     → { highlights: [{ NodeId, Name }] }
 *  2. GET /Event/GetEvents?parentid={leagueNodeId}
 *     → [{ Name, ParticipantHome, ParticipantAway, Games: [{ Results: [{ Name, Odd }] }] }]
 */

import * as https from "https";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine } from "../types";
import { saveFailedPayload } from "./playwright-base";

const BASE = "https://m.apuestas.codere.es/NavigationService";

// Sport NodeIds — from /NavigationService/LeftMenu/GetMenuLeft (static, verified 2026-07)
// Volleyball nodeId/handle unconfirmed — will be verified when proxy is available
const SPORT_NODEIDS: Partial<Record<Sport, string>> = {
  FOOTBALL:   "9553177903",
  TENNIS:     "2819846742",
  BASKETBALL: "2819833466",
  VOLLEYBALL: "2819833467",
};

const SPORT_HANDLES: Partial<Record<Sport, string>> = {
  FOOTBALL:   "soccer",
  TENNIS:     "tennis",
  BASKETBALL: "basketball",
  VOLLEYBALL: "volleyball",
};

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function codereGet(path: string): Promise<any> {
  const url = `${BASE}/${path}`;
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        Accept: "application/json",
        Referer: "https://m.apuestas.codere.es/deportesEs/",
        Origin: "https://m.apuestas.codere.es",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Mobile Safari/537.36",
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(15_000, () => { req.destroy(); resolve(null); });
  });
}

// ─── Date parser ─────────────────────────────────────────────────────────────

function parseCodereDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  // Format: "/Date(1786815000000)/"
  const m = raw.match(/\/Date\((-?\d+)\)\//);
  return m ? new Date(parseInt(m[1])) : undefined;
}

// ─── Secondary market helpers ─────────────────────────────────────────────────

const ES_MARKET_MAP: Array<[RegExp, string]> = [
  // Skip H2H — handled via DefaultGame / Games[0]
  [/resultado\s*(final)?|ganador\s*del\s*partido|match\s*result|1\s*x\s*2/i, "h2h"],
  // Handicap
  [/h[aá]ndicap(?:\s+asi[aá]tico)?|handicap/i, "handicap"],
  // Goals by half
  [/(?:primer[ao]|1[aº])\s*mitad.*goles?|goles?.*(?:primer[ao]|1[aº])\s*mitad|ht\s*goals?/i, "h1_goals"],
  [/(?:segund[ao]|2[aº])\s*mitad.*goles?|goles?.*(?:segund[ao]|2[aº])\s*mitad|2h\s*goals?/i, "h2_goals"],
  // Goals (total)
  [/total\s+(?:de\s+)?goles?|goles?\s+totales?|m[aá]s\s*\/?\s*menos.*goles?|\bgoles?\b/i, "goals"],
  // Corners
  [/c[oó]rners?|saques?\s+de\s+esquina/i, "corners"],
  // Cards
  [/tarjetas?\s+amarillas?|yellow\s+cards?/i, "yellow_cards"],
  [/tarjetas?\s+rojas?|red\s+cards?/i, "red_cards"],
  [/tarjetas?\s+totales?|total\s+(?:de\s+)?tarjetas?/i, "cards"],
  // Tennis
  [/total\s+(?:de\s+)?juegos?|juegos?\s+totales?/i, "games"],
  [/total\s+(?:de\s+)?sets?|sets?\s+totales?/i, "sets"],
  [/\baces?\b/i, "aces"],
  [/dobles?\s*faltas?/i, "double_faults"],
  // Basketball points
  [/total\s+(?:de\s+)?puntos?|puntos?\s+totales?/i, "match_points"],
];

function classifyCodereGame(name: string): string | null {
  for (const [re, cat] of ES_MARKET_MAP) {
    if (re.test(name)) return cat;
  }
  return null;
}

function parseCodereOverUnder(results: any[]): TotalsLine[] {
  const byLine = new Map<number, { over: number; under: number }>();
  for (const r of results) {
    const odds = parseFloat(String(r.Odd ?? 0));
    if (odds < 1.01) continue;
    const name: string = (r.Name ?? "").toLowerCase();
    const lineMatch = name.match(/(\d+[.,]\d+|\d+)/);
    if (!lineMatch) continue;
    const line = parseFloat(lineMatch[1].replace(",", "."));
    const isOver  = /m[aá]s\s*de|over|plus/i.test(name);
    const isUnder = /menos\s*de|under|minus/i.test(name);
    if (!isOver && !isUnder) continue;
    const cur = byLine.get(line) ?? { over: 0, under: 0 };
    if (isOver  && odds > cur.over)  cur.over  = odds;
    if (isUnder && odds > cur.under) cur.under = odds;
    byLine.set(line, cur);
  }
  return [...byLine.entries()]
    .filter(([, { over, under }]) => over >= 1.01 && under >= 1.01)
    .map(([line, { over, under }]) => ({ line, over, under }));
}

function parseCodereHandicap(results: any[]): H2HOutcome[] {
  const out: H2HOutcome[] = [];
  for (const r of results) {
    const odds = parseFloat(String(r.Odd ?? 0));
    if (odds < 1.01) continue;
    const name: string = r.Name ?? "";
    out.push({ name, odds });
  }
  return out;
}

function buildSecondaryEvent(
  bookmaker: string,
  sport: Sport,
  eventName: string,
  startTime: Date | undefined,
  isLive: boolean,
  marketCat: string,
  results: any[],
): ScrapedEvent | null {
  const eventKey = buildEventKey(sport, eventName, startTime);
  if (marketCat === "handicap") {
    const outcomes = parseCodereHandicap(results);
    if (outcomes.length < 2) return null;
    return { bookmaker, sport, eventKey, eventName, startTime, isLive, market: "handicap", outcomes };
  }
  const lines = parseCodereOverUnder(results);
  if (lines.length === 0) return null;
  return { bookmaker, sport, eventKey, eventName, startTime, isLive, market: marketCat, outcomes: lines };
}

// ─── Odds parser ─────────────────────────────────────────────────────────────

function buildEvent(
  results: any[],
  bookmaker: string,
  sport: Sport,
  eventName: string,
  startTime: Date | undefined,
  isLive: boolean,
): ScrapedEvent | null {
  if (!results || results.length < 2) return null;
  const sorted = [...results].sort((a, b) => (a.SortOrder ?? 0) - (b.SortOrder ?? 0));
  const outcomes: H2HOutcome[] = sorted
    .map((r: any) => {
      const odds = parseFloat(String(r.Odd ?? 0));
      const name: string = r.Name ?? "";
      return odds >= 1.01 && name ? { name, odds } : null;
    })
    .filter(Boolean) as H2HOutcome[];
  if (outcomes.length < 2) return null;
  const eventKey = buildEventKey(sport, eventName, startTime);
  return { bookmaker, sport, eventKey, eventName, startTime, isLive, market: "h2h", outcomes };
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

export class CodereScraper extends BaseScraper {
  readonly name = "codere";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "VOLLEYBALL"];

  async scrapeLive(): Promise<ScrapedEvent[]> {
    const data = await codereGet("Event/GetLiveEventsAndSportsBySportHandle?gametypes=");
    if (!data?.Events?.length) {
      this.warn("Live: no data from NavigationService");
      return [];
    }

    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      const handle = SPORT_HANDLES[sport];
      const sportEvents: any[] = data.Events.filter((e: any) => e.SportHandle === handle);
      let found = 0;
      for (const e of sportEvents) {
        const name: string = e.Name ?? `${e.ParticipantHome ?? ""} - ${e.ParticipantAway ?? ""}`.trim();
        const startTime = parseCodereDate(e.StartDate);
        // H2H from DefaultGame
        const defaultResults: any[] = e.DefaultGame?.Results ?? [];
        const ev = buildEvent(defaultResults, "codere", sport, name, startTime, true);
        if (ev) { all.push(ev); found++; }
        // Secondary markets from Games[]
        for (const game of (e.Games ?? [])) {
          const cat = classifyCodereGame(game.Name ?? game.GameType ?? "");
          if (!cat || cat === "h2h") continue;
          const sec = buildSecondaryEvent("codere", sport, name, startTime, true, cat, game.Results ?? []);
          if (sec) all.push(sec);
        }
      }
      if (sportEvents.length) this.log(`Live ${sport}: ${found}/${sportEvents.length} events with odds`);
    }
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    const all: ScrapedEvent[] = [];

    for (const sport of this.sports) {
      const nodeId = SPORT_NODEIDS[sport];

      // 1. Get highlighted leagues for this sport
      const menuData = await codereGet(`LeftMenu/GetCountriesAndHighlights?parentid=${nodeId}`);
      const highlights: any[] = menuData?.highlights ?? [];

      if (!highlights.length) {
        this.warn(`Prematch ${sport}: no highlights from GetCountriesAndHighlights`);
        continue;
      }

      // 2. Fetch events for each highlighted league (top 5 to limit API calls)
      let found = 0;
      const leaguesToFetch = highlights.slice(0, 5);
      for (const league of leaguesToFetch) {
        const leagueNodeId: string = String(league.NodeId ?? "");
        if (!leagueNodeId) continue;
        const events = await codereGet(`Event/GetEvents?parentid=${leagueNodeId}`);
        if (!Array.isArray(events)) continue;

        for (const e of events) {
          const name: string = e.Name ?? `${e.ParticipantHome ?? ""} - ${e.ParticipantAway ?? ""}`.trim();
          if (!name) continue;
          const games: any[] = e.Games ?? [];
          const startTime = parseCodereDate(e.StartDate);
          let hadH2H = false;
          for (const game of games) {
            const gameName: string = game.Name ?? game.GameType ?? "";
            const cat = classifyCodereGame(gameName);
            if (cat === "h2h" || (!cat && !hadH2H)) {
              // First unclassified game is typically the main result market
              const ev = buildEvent(game.Results ?? [], "codere", sport, name, startTime, false);
              if (ev) { all.push(ev); found++; hadH2H = true; }
            } else if (cat && cat !== "h2h") {
              const sec = buildSecondaryEvent("codere", sport, name, startTime, false, cat, game.Results ?? []);
              if (sec) all.push(sec);
            }
          }
        }
      }
      this.log(`Prematch ${sport}: ${found} events from ${leaguesToFetch.length} leagues`);
    }
    return all;
  }
}
