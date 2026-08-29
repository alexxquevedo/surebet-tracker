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
  HANDBALL:         "2819843470",
};

// Secondary market gametypes per sport (semicolon-separated IDs for NavigationService)
// Verified 2026-08-23 via sweep: 54=corners O/U, 59=corners par/impar, 62=cards O/U,
// 77=red card, 133/134=team corners O/U, 4=handicap, 18=goals O/U, 31=BTTS, 12/24/27=half goals
const SPORT_GAMETYPES: Partial<Record<Sport, string>> = {
  FOOTBALL:         "4;5;12;14;15;18;24;27;31;54;59;62;77;133;134;1812;1813",
  TENNIS:           "4;18",
  BASKETBALL:       "4;18",
  ICEHOCKEY:        "4;18",
  BASEBALL:         "4;18",
  AMERICANFOOTBALL: "4;18",
  RUGBYLEAGUE:      "4;18",
  VOLLEYBALL:       "4;18",
  HANDBALL:         "4;18",
};

// Live secondary gametypes (same IDs work on live endpoint)
const LIVE_SECONDARY_GAMETYPES = "4;5;12;14;15;18;24;27;31;54;59;62;77;133;134;1812;1813";

const SPORT_HANDLES: Partial<Record<Sport, string>> = {
  FOOTBALL:         "soccer",
  TENNIS:           "tennis",
  BASKETBALL:       "basketball",
  VOLLEYBALL:       "volleyball",
  AMERICANFOOTBALL: "american_football",
  ICEHOCKEY:        "ice_hockey",
  BASEBALL:         "baseball",
  RUGBYLEAGUE:      "rugby_league",
  HANDBALL:         "handball",
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
  // 1ª/Primera Parte goles — handles "1ª Parte - Total Goles" and "1ª Parte - Más/Menos Total Goles"
  [/(?:primer[ao]|1[aªº°])\s*(?:mitad|parte).*goles?|goles?.*(?:primer[ao]|1[aªº°])\s*(?:mitad|parte)|ht\s*goals?/i, "h1_goals"],
  [/(?:segund[ao]|2[aªº°])\s*(?:mitad|parte).*goles?|goles?.*(?:segund[ao]|2[aªº°])\s*(?:mitad|parte)|2h\s*goals?/i, "h2_goals"],
  [/marcan\s+ambos\s+equipos|both\s+teams?\s+to\s+score|btts/i, "btts"],
  [/total\s+(?:de\s+)?goles?|goles?\s+totales?|m[aá]s\s*\/?\s*menos.*goles?|\bgoles?\b/i, "goals"],
  // Corners — "Total Córner Más/Menos", team-level "Total Córners Más/Menos SD Eibar"
  [/c[oó]rne?rs?|saques?\s+de\s+esquina/i, "corners"],
  // Cards — "Total Tarjetas Más/Menos", "¿Habrá Tarjeta Roja?"
  [/tarjetas?\s+amarillas?|yellow\s+cards?/i, "yellow_cards"],
  [/tarjetas?\s+rojas?|red\s+cards?|\btar[jg]eta\s+roja\b/i, "red_cards"],
  [/tarjetas?\s+totales?|total\s+(?:de\s+)?tarjetas?|total\s+tarjetas?\s+m[aá]s/i, "cards"],
  [/disparos?\s+(?:a\s+puerta|totales?)|tiros?\s+(?:a\s+puerta|totales?)/i, "shots"],
  [/total\s+(?:de\s+)?juegos?|juegos?\s+totales?/i, "games"],
  [/total\s+(?:de\s+)?sets?|sets?\s+totales?/i, "sets"],
  [/\baces?\b/i, "aces"],
  [/dobles?\s*faltas?/i, "double_faults"],
  [/total\s+(?:de\s+)?puntos?|puntos?\s+totales?/i, "match_points"],
  // Baseball
  [/jonrones?|home\s*runs?/i, "home_runs"],
  [/total\s+(?:de\s+)?carreras?|carreras?\s+totales?|\bcarreras?\b/i, "runs"],
  // Rugby
  [/ensayos?\s+totales?|total\s+(?:de\s+)?ensayos?|\bensayos?\b/i, "tries"],
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
    const isOver  = /m[aá]s(?:\s+de)?\s|\bover\b|\bplus\b|\bsobre\b/i.test(name);
    const isUnder = /menos(?:\s+de)?\s|\bunder\b|\bminus\b|\bbajo\b/i.test(name);
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
  league = "",
): ScrapedEvent | null {
  const gameName: string = game.Name ?? game.GameType ?? "";
  const results: any[] = game.Results ?? [];
  const eventKey = buildEventKey(sport, eventName, startTime);

  // 1. Player prop detection (highest priority)
  const propMeta = detectPlayerPropGame(gameName);
  if (propMeta) {
    const outcomes = parsePlayerPropOutcomes(results, propMeta.player, propMeta.stat);
    if (outcomes.length === 0) return null;
    return { bookmaker, sport, eventKey, eventName, league: league || undefined, startTime, isLive, market: "player_props", outcomes };
  }

  // 2. Generic market classification
  const cat = classifyCodereGame(gameName);
  if (!cat || cat === "h2h") return null;

  if (cat === "handicap") {
    const outcomes = parseCodereHandicap(results);
    if (outcomes.length < 2) return null;
    return { bookmaker, sport, eventKey, eventName, league: league || undefined, startTime, isLive, market: "handicap", outcomes };
  }

  // Binary yes/no markets (btts, red_cards): use H2HOutcome with Sí/No labels
  if (cat === "btts" || cat === "red_cards") {
    const outcomes = parseCodereHandicap(results);
    if (outcomes.length < 2) return null;
    return { bookmaker, sport, eventKey, eventName, league: league || undefined, startTime, isLive, market: cat, outcomes };
  }

  const lines = parseCodereOverUnder(results);
  if (lines.length === 0) return null;
  return { bookmaker, sport, eventKey, eventName, league: league || undefined, startTime, isLive, market: cat, outcomes: lines };
}

// ─── H2H parser ──────────────────────────────────────────────────────────────

function buildH2HEvent(
  results: any[],
  bookmaker: string,
  sport: Sport,
  eventName: string,
  startTime: Date | undefined,
  isLive: boolean,
  league = "",
): ScrapedEvent | null {
  if (!results || results.length < 2) return null;
  const sorted = [...results].sort((a, b) => (a.SortOrder ?? 0) - (b.SortOrder ?? 0));
  const NON_H2H = /(goles?|tarjetas?|c[oó]rner|sin\s+gol|btts|rojas?)|m[aá]s\s+\d|menos\s+\d/i;
  const outcomes: H2HOutcome[] = sorted
    .map((r: any) => {
      const odds = parseFloat(String(r.Odd ?? 0));
      const name: string = r.Name ?? "";
      if (NON_H2H.test(name)) return null;
      return odds >= 1.01 && name ? { name, odds } : null;
    })
    .filter(Boolean)
    .slice(0, 3) as H2HOutcome[];  // 1X2 never exceeds 3 outcomes
  if (outcomes.length < 2) return null;
  const eventKey = buildEventKey(sport, eventName, startTime);
  return { bookmaker, sport, eventKey, eventName, league: league || undefined, startTime, isLive, market: "h2h", outcomes };
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

export class CodereScraper extends BaseScraper {
  readonly name = "codere";
  readonly sports: Sport[] = [
    "FOOTBALL", "TENNIS", "BASKETBALL", "VOLLEYBALL",
    "AMERICANFOOTBALL", "ICEHOCKEY", "BASEBALL", "RUGBYLEAGUE", "HANDBALL",
  ];

  async scrapeLive(): Promise<ScrapedEvent[]> {
    // Primary call: gets h2h via DefaultGame for all sports
    const data = await codereGet("Event/GetLiveEventsAndSportsBySportHandle?gametypes=");
    if (!data?.Events?.length) {
      this.warn("Live: no data from NavigationService");
      return [];
    }

    // Secondary call: gets handicap, totals, BTTS, halftime markets via gametypes
    const secData = await codereGet(`Event/GetLiveEventsAndSportsBySportHandle?gametypes=${LIVE_SECONDARY_GAMETYPES}`);
    const secByNodeId = new Map<string, any[]>();
    for (const e of (secData?.Events ?? [])) {
      if (e.NodeId && e.Games?.length) secByNodeId.set(String(e.NodeId), e.Games);
    }

    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      const handle = SPORT_HANDLES[sport];
      const sportEvents: any[] = data.Events.filter((e: any) => e.SportHandle === handle);
      let found = 0;

      for (const e of sportEvents) {
        const name: string = e.Name ?? `${e.ParticipantHome ?? ""} - ${e.ParticipantAway ?? ""}`.trim();
        const startTime = parseCodereDate(e.StartDate);
        const liveLeague = String(e.CompetitionName ?? e.LeagueName ?? e.TournamentName ?? e.CategoryName ?? e.ParentName ?? "");

        // H2H from DefaultGame (always present for live)
        const h2h = buildH2HEvent(e.DefaultGame?.Results ?? [], "codere", sport, name, startTime, true, liveLeague);
        if (h2h) { all.push(h2h); found++; }

        // Secondary markets from primary call Games[] (may be empty)
        for (const game of (e.Games ?? [])) {
          const sec = processCodereGame(game, "codere", sport, name, startTime, true, liveLeague);
          if (sec) all.push(sec);
        }

        // Secondary markets from dedicated gametypes call
        for (const game of (secByNodeId.get(String(e.NodeId)) ?? [])) {
          const sec = processCodereGame(game, "codere", sport, name, startTime, true, liveLeague);
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
      const gametypes = SPORT_GAMETYPES[sport] ?? "4;18";

      const menuData = await codereGet(`LeftMenu/GetCountriesAndHighlights?parentid=${nodeId}`);
      const highlights: any[] = menuData?.highlights ?? [];

      const seenNodeIds = new Set<string>();
      const leaguesToFetch: any[] = [];

      // Always start with highlights (promoted leagues)
      for (const h of highlights) {
        const nid = String(h.NodeId ?? "");
        if (nid && !seenNodeIds.has(nid)) { seenNodeIds.add(nid); leaguesToFetch.push(h); }
      }
      // Supplement with country leagues until we have up to 15
      const countries: any[] = menuData?.countries ?? [];
      for (const country of countries.slice(0, 10)) {
        for (const league of (country.Leagues ?? []).slice(0, 4)) {
          const nid = String(league.NodeId ?? "");
          if (nid && !seenNodeIds.has(nid)) { seenNodeIds.add(nid); leaguesToFetch.push(league); }
          if (leaguesToFetch.length >= 15) break;
        }
        if (leaguesToFetch.length >= 15) break;
      }

      if (!leaguesToFetch.length) {
        this.warn("Prematch " + sport + ": no leagues available");
        continue;
      }

      const leagueSource = highlights.length ? "highlights+countries" : "countries";
      let found = 0;

      for (const league of leaguesToFetch) {
        const leagueNodeId: string = String(league.NodeId ?? "");
        if (!leagueNodeId) continue;
        const leagueLabel: string = String(league.Name ?? league.CompetitionName ?? league.Title ?? "");

        // Primary call: h2h events (no gametypes = only 1X2 in Games[0])
        const events = await codereGet(`Event/GetEvents?parentid=${leagueNodeId}`);
        if (!Array.isArray(events)) continue;

        // Secondary call: all other markets via gametypes
        const secEvents = await codereGet(`Event/GetEvents?parentid=${leagueNodeId}&gametypes=${gametypes}`);
        const secByNodeId = new Map<string, any[]>();
        if (Array.isArray(secEvents)) {
          for (const se of secEvents) {
            if (se.NodeId && se.Games?.length) secByNodeId.set(String(se.NodeId), se.Games);
          }
        }

        for (const e of events) {
          const name: string = e.Name ?? `${e.ParticipantHome ?? ""} - ${e.ParticipantAway ?? ""}`.trim();
          if (!name) continue;
          const startTime = parseCodereDate(e.StartDate);
          let hadH2H = false;

          // H2H from primary call Games[0]
          for (const game of (e.Games ?? [])) {
            const gameName: string = game.Name ?? game.GameType ?? "";
            const cat = classifyCodereGame(gameName);
            if (cat === "h2h" || (!cat && !hadH2H && !detectPlayerPropGame(gameName))) {
              const h2h = buildH2HEvent(game.Results ?? [], "codere", sport, name, startTime, false, leagueLabel);
              if (h2h) { all.push(h2h); found++; hadH2H = true; }
              continue;
            }
            const sec = processCodereGame(game, "codere", sport, name, startTime, false, leagueLabel);
            if (sec) all.push(sec);
          }

          // Secondary markets from gametypes call
          for (const game of (secByNodeId.get(String(e.NodeId)) ?? [])) {
            const sec = processCodereGame(game, "codere", sport, name, startTime, false);
            if (sec) all.push(sec);
          }
        }
      }
      this.log(`Prematch ${sport}: ${found} events from ${leaguesToFetch.length} leagues (${leagueSource})`);
    }
    return all;
  }
}
