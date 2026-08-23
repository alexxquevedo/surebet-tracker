/**
 * Codere España — NavigationService HTTP scraper (sin navegador).
 *
 * NodeIds verificados el 2026-08-23 vía GET /LeftMenu/GetMenuLeft
 *
 * Live:    GET /Event/GetLiveEventsAndSportsBySportHandle?gametypes=
 *          → { Events: [{ Name, SportHandle, DefaultGame: { Results: [{ Name, Odd, SortOrder }] }, Games: [...] }] }
 *
 * Prematch (por liga):
 *  1. GET /LeftMenu/GetCountriesAndHighlights?parentid={sportNodeId}
 *     → { highlights: [{ NodeId, Name }] }
 *  2. GET /Event/GetEvents?parentid={leagueNodeId}
 *     → [{ Name, ParticipantHome, ParticipantAway, Games: [{ Name, Results: [{ Name, Odd }] }] }]
 */

import * as https from "https";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine, PlayerPropLine } from "../types";

const BASE = "https://m.apuestas.codere.es/NavigationService";

// Verified 2026-08-23 via /LeftMenu/GetMenuLeft
const SPORT_NODEIDS: Partial<Record<Sport, string>> = {
  FOOTBALL:         "9553177903",
  TENNIS:           "2819846742",
  BASKETBALL:       "9612775584",
  VOLLEYBALL:       "2819853525",
  AMERICANFOOTBALL: "2819729850",
  ICEHOCKEY:        "2819844477",
  BASEBALL:         "2819833156",
  RUGBYLEAGUE:      "2819844959",
};

const SPORT_HANDLES: Partial<Record<Sport, string>> = {
  FOOTBALL:         "soccer",
  TENNIS:           "tennis",
  BASKETBALL:       "basketball",
  VOLLEYBALL:       "volleyball",
  AMERICANFOOTBALL: "american_football",
  ICEHOCKEY:        "ice_hockey",
  BASEBALL:         "baseball",
  RUGBYLEAGUE:      "rugby_league",
};

// ─── HTTP helper ──────────────────────────────────────────────────────────────

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
  const m = raw.match(/\/Date\((-?\d+)\)\//);
  return m ? new Date(parseInt(m[1])) : undefined;
}

// ─── Player prop detection ────────────────────────────────────────────────────

// Maps Spanish/English stat keyword → canonical stat name (all 8 sports)
const PLAYER_PROP_STATS: Array<[RegExp, string]> = [
  // ── Basketball ──
  [/\bpuntos?\b/i,                               "PTS"],
  [/\brebotes?\b/i,                              "REB"],
  [/\basistencias?\b/i,                          "AST"],
  [/\btriples?\b/i,                              "3PT"],
  [/tapones?\s*(?:y\s*robos?)?/i,                "BLK"],
  [/\brobos?\b/i,                                "STL"],
  [/\bpra\b/i,                                   "PRA"],
  [/\bpoints?\b/i,                               "PTS"],
  [/\brebound[s]?\b/i,                           "REB"],
  [/\bassist[s]?\b/i,                            "AST"],
  [/3-?pointer[s]?|\bthree[s]?\b/i,              "3PT"],
  // ── Football (soccer) ──
  [/goles?\s*(?:en\s*cualquier\s*momento|del\s*jugador)?/i, "goals"],
  [/disparos?\s*(?:a\s*puerta|totales?)?/i,      "shots"],
  [/pases?\s*(?:totales?|completados?)?/i,       "passes"],
  [/regates?\s*(?:completados?)?/i,              "dribbles"],
  [/duelos?\s*(?:ganados?|a[eé]reos?)?/i,        "duels"],
  [/toques?\s*(?:al\s*bal[oó]n)?/i,              "touches"],
  [/tarjetas?\s*(?:del\s*jugador|individuales?)?/i, "player_cards"],
  // ── Tennis ──
  [/\baces?\b/i,                                 "aces"],
  [/dobles?\s*faltas?|double\s*faults?/i,        "double_faults"],
  [/juegos?\s*(?:ganados?|del\s*jugador)?/i,     "games_won"],
  [/sets?\s*(?:ganados?)?/i,                     "sets_won"],
  // ── Baseball ──
  [/jonrones?|home\s*runs?/i,                    "HR"],
  [/bases?\s*robadas?|stolen\s*bases?/i,         "SB"],
  [/ponches?|strikeouts?/i,                      "K"],
  [/\bhits?\b/i,                                 "H"],
  [/carreras?\s*(?:impulsadas?)?|rbis?/i,        "RBI"],
  // ── American football ──
  [/yardas?\s*(?:de\s*pase|pasantes?|aéreas?)/i, "pass_yds"],
  [/yardas?\s*(?:terrestres?|corridas?)/i,       "rush_yds"],
  [/yardas?\s*(?:de\s*recepci[oó]n|recibidas?)/i, "rec_yds"],
  [/recepciones?|receptions?/i,                  "REC"],
  [/touchdowns?|tds?/i,                          "TD"],
  // ── Ice hockey ──
  [/disparos?\s*(?:al\s*arco|a\s*puerta)\s*hockey/i, "sog"],
  [/puntos?\s*hockey|hockey\s*puntos?/i,         "hockey_pts"],
  // ── Rugby ──
  [/ensayos?|tries?/i,                           "tries"],
  [/conversiones?/i,                             "conversions"],
];

// Detects "[Player] - [Stat]" or "[Stat] - [Player]" game names.
// Returns {player, stat} if it looks like a player prop, null otherwise.
function detectPlayerPropGame(gameName: string): { player: string; stat: string } | null {
  const parts = gameName.split(/\s*[-–—]\s*/);
  if (parts.length < 2) return null;

  // Try "[Player] - [Stat keyword]" — stat is last segment
  const lastPart = parts[parts.length - 1];
  for (const [re, stat] of PLAYER_PROP_STATS) {
    if (re.test(lastPart)) {
      const player = parts.slice(0, -1).join(" ").trim();
      if (player.length >= 2) return { player, stat };
    }
  }

  // Try "[Stat keyword] - [Player]" — stat is first segment
  const firstPart = parts[0];
  for (const [re, stat] of PLAYER_PROP_STATS) {
    if (re.test(firstPart)) {
      const player = parts.slice(1).join(" ").trim();
      if (player.length >= 2) return { player, stat };
    }
  }

  return null;
}

function parsePlayerPropOutcomes(results: any[], player: string, stat: string): PlayerPropLine[] {
  const byLine = new Map<number, { over: number; under: number }>();
  for (const r of results) {
    const odds = parseFloat(String(r.Odd ?? 0));
    if (odds < 1.01) continue;
    const name: string = (r.Name ?? "").toLowerCase();
    const lineMatch = name.match(/(\d+[.,]\d+|\d+)/);
    if (!lineMatch) continue;
    const line = parseFloat(lineMatch[1].replace(",", "."));
    const isOver  = /m[aá]s\s*de|over|\+/.test(name);
    const isUnder = /menos\s*de|under/.test(name);
    if (!isOver && !isUnder) continue;
    const cur = byLine.get(line) ?? { over: 0, under: 0 };
    if (isOver  && odds > cur.over)  cur.over  = odds;
    if (isUnder && odds > cur.under) cur.under = odds;
    byLine.set(line, cur);
  }
  return [...byLine.entries()]
    .filter(([, { over, under }]) => over >= 1.01 && under >= 1.01)
    .map(([line, { over, under }]) => ({ player, stat, line, over, under }));
}

// ─── Secondary market helpers ─────────────────────────────────────────────────

const ES_MARKET_MAP: Array<[RegExp, string]> = [
  [/resultado\s*(final)?|ganador\s*del\s*partido|match\s*result|1\s*x\s*2/i, "h2h"],
  [/h[aá]ndicap(?:\s+asi[aá]tico)?|handicap/i, "handicap"],
  [/(?:primer[ao]|1[aº])\s*mitad.*goles?|goles?.*(?:primer[ao]|1[aº])\s*mitad|ht\s*goals?/i, "h1_goals"],
  [/(?:segund[ao]|2[aº])\s*mitad.*goles?|goles?.*(?:segund[ao]|2[aº])\s*mitad|2h\s*goals?/i, "h2_goals"],
  [/total\s+(?:de\s+)?goles?|goles?\s+totales?|m[aá]s\s*\/?\s*menos.*goles?|\bgoles?\b/i, "goals"],
  [/c[oó]rners?|saques?\s+de\s+esquina/i, "corners"],
  [/tarjetas?\s+amarillas?|yellow\s+cards?/i, "yellow_cards"],
  [/tarjetas?\s+rojas?|red\s+cards?/i, "red_cards"],
  [/tarjetas?\s+totales?|total\s+(?:de\s+)?tarjetas?/i, "cards"],
  [/total\s+(?:de\s+)?juegos?|juegos?\s+totales?/i, "games"],
  [/total\s+(?:de\s+)?sets?|sets?\s+totales?/i, "sets"],
  [/\baces?\b/i, "aces"],
  [/dobles?\s*faltas?/i, "double_faults"],
  [/total\s+(?:de\s+)?puntos?|puntos?\s+totales?/i, "match_points"],
  // Baseball
  [/total\s+(?:de\s+)?carreras?|carreras?\s+totales?/i, "runs"],
  // American football
  [/touchdowns?/i, "touchdowns"],
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
  return results
    .map((r: any) => {
      const odds = parseFloat(String(r.Odd ?? 0));
      const name: string = r.Name ?? "";
      return odds >= 1.01 && name ? { name, odds } : null;
    })
    .filter(Boolean) as H2HOutcome[];
}

// ─── Process a single game entry from Codere API ──────────────────────────────

function processCodereGame(
  game: any,
  bookmaker: string,
  sport: Sport,
  eventName: string,
  startTime: Date | undefined,
  isLive: boolean,
): ScrapedEvent | null {
  const gameName: string = game.Name ?? game.GameType ?? "";
  const results: any[] = game.Results ?? [];
  const eventKey = buildEventKey(sport, eventName, startTime);

  // 1. Player prop detection (highest priority)
  const propMeta = detectPlayerPropGame(gameName);
  if (propMeta) {
    const outcomes = parsePlayerPropOutcomes(results, propMeta.player, propMeta.stat);
    if (outcomes.length === 0) return null;
    return { bookmaker, sport, eventKey, eventName, startTime, isLive, market: "player_props", outcomes };
  }

  // 2. Generic market classification
  const cat = classifyCodereGame(gameName);
  if (!cat || cat === "h2h") return null;

  if (cat === "handicap") {
    const outcomes = parseCodereHandicap(results);
    if (outcomes.length < 2) return null;
    return { bookmaker, sport, eventKey, eventName, startTime, isLive, market: "handicap", outcomes };
  }

  const lines = parseCodereOverUnder(results);
  if (lines.length === 0) return null;
  return { bookmaker, sport, eventKey, eventName, startTime, isLive, market: cat, outcomes: lines };
}

// ─── H2H parser ──────────────────────────────────────────────────────────────

function buildH2HEvent(
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
  readonly sports: Sport[] = [
    "FOOTBALL", "TENNIS", "BASKETBALL", "VOLLEYBALL",
    "AMERICANFOOTBALL", "ICEHOCKEY", "BASEBALL", "RUGBYLEAGUE",
  ];

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

        // H2H from DefaultGame (always present for live)
        const h2h = buildH2HEvent(e.DefaultGame?.Results ?? [], "codere", sport, name, startTime, true);
        if (h2h) { all.push(h2h); found++; }

        // All other markets from Games[] (props, totals, handicap, etc.)
        for (const game of (e.Games ?? [])) {
          const sec = processCodereGame(game, "codere", sport, name, startTime, true);
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

      const menuData = await codereGet(`LeftMenu/GetCountriesAndHighlights?parentid=${nodeId}`);
      const highlights: any[] = menuData?.highlights ?? [];

      if (!highlights.length) {
        this.warn(`Prematch ${sport}: no highlights`);
        continue;
      }

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

            // First game or first "h2h"-classified game → main result market
            if (cat === "h2h" || (!cat && !hadH2H && !detectPlayerPropGame(gameName))) {
              const h2h = buildH2HEvent(game.Results ?? [], "codere", sport, name, startTime, false);
              if (h2h) { all.push(h2h); found++; hadH2H = true; }
              continue;
            }

            // All secondary markets (props, totals, handicap)
            const sec = processCodereGame(game, "codere", sport, name, startTime, false);
            if (sec) all.push(sec);
          }
        }
      }
      this.log(`Prematch ${sport}: ${found} events from ${leaguesToFetch.length} leagues`);
    }
    return all;
  }
}
