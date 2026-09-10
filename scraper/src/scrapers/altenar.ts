/**
 * Altenar B2B platform scraper — Spanish bookmakers.
 *
 * Bookmakers on Altenar: Luckia, Casino Gran Madrid, TonyBet ES, Pastón
 * API: sb2frontend-altenar2.licence.widgets.altenar.com
 *
 * Requires Spanish ISP proxy (ALTENAR_PROXY_URL) — CDN blocks datacenter IPs.
 *
 * Usage: new AltenarScraper("luckia",           "Luckia")
 *        new AltenarScraper("casino-gran-madrid","CasinoGranMadrid")
 *        new AltenarScraper("tonybet",           "TonyBet")
 *        new AltenarScraper("paston",            "Paston")
 *
 * Markets scraped (all sports):
 *   h2h, double_chance, handicap, asian_handicap, btts,
 *   goals/corners/cards/shots (O/U), sets, games, match_points,
 *   h1_goals, h2_goals, player_props
 */

import axios from "axios";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import { config } from "../config";
import { createProxiedAxios } from "./proxy-helper";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine, PlayerPropLine } from "../types";

// Altenar sport IDs (confirmed: football=66, tennis=80, basketball=67)
const ALTENAR_SPORT_IDS: Partial<Record<Sport, number>> = {
  FOOTBALL:         66,
  TENNIS:           80,
  BASKETBALL:       67,
  AMERICANFOOTBALL: 75,
  ICEHOCKEY:        74,
  BASEBALL:         83,
};

const ALTENAR_CDN = "https://sb2frontend-altenar2.licence.widgets.altenar.com";

// ─── Type stubs ──────────────────────────────────────────────────────────────

interface AltenarSelection {
  Id?: number;
  Name?: string;
  Price?: number;
  Status?: string;
  IsActive?: boolean;
}

interface AltenarMarket {
  Id?: number;
  Name?: string;
  CategoryName?: string;
  TypeName?: string;
  MarketTypeName?: string;
  Selections?: AltenarSelection[];
  IsMain?: boolean;
  OrderPosition?: number;
}

interface AltenarEvent {
  Id?: number;
  Name?: string;
  Home?: string;
  Away?: string;
  TeamHome?: string;
  TeamAway?: string;
  MatchStatus?: string; // "InProgress" | "Prematch"
  Markets?: AltenarMarket[];
  MainMarket?: AltenarMarket;
  StartDate?: string;
  SportId?: number;
  CategoryId?: number;
}

interface AltenarResponse {
  Result?: AltenarEvent[];
  Events?: AltenarEvent[];
  Data?: { Events?: AltenarEvent[] };
}

// ─── Market classification ────────────────────────────────────────────────────

const MARKET_PATTERNS: Array<[RegExp, string]> = [
  [/ambos\s+(?:equipos\s+)?marcan|both\s+teams?\s+(to\s+)?score|btts/i,         "btts"],
  [/doble\s+oportunidad|double\s+chance/i,                                        "double_chance"],
  [/h[aá]ndicap\s+asi[aá]tico|asian\s+handicap/i,                                "asian_handicap"],
  [/h[aá]ndicap|handicap/i,                                                       "handicap"],
  // Half-time markets (before generic goals match)
  [/primera\s+(?:mitad|parte)|1[aª]\s*(?:mitad|parte)|half[\s-]time\s+goals?|ht\s+goals?|primer\s+tiempo\s+goles?/i, "h1_goals"],
  [/segunda\s+(?:mitad|parte)|2[aª]\s*(?:mitad|parte)|2nd\s+half\s+goals?|segundo\s+tiempo\s+goles?/i,               "h2_goals"],
  // Corners
  [/c[oó]rne?rs?|corners?\s+totales?|saques?\s+de\s+esquina/i,                   "corners"],
  // Cards — specific before generic
  [/tarjetas?\s+amarillas?|yellow\s+cards?/i,                                     "yellow_cards"],
  [/tarjetas?\s+rojas?|red\s+cards?/i,                                            "red_cards"],
  [/tarjetas?\s+totales?|total\s+(?:de\s+)?tarjetas?/i,                           "cards"],
  // Shots
  [/disparos?\s+(?:a\s+puerta|totales?)|tiros?\s+(?:a\s+puerta|totales?)|shots?/i, "shots"],
  // Tennis / basketball
  [/total\s+(?:de\s+)?sets?|sets?\s+totales?|\bsets?\b/i,                        "sets"],
  [/total\s+(?:de\s+)?juegos?|juegos?\s+totales?/i,                              "games"],
  [/total\s+(?:de\s+)?puntos?|puntos?\s+totales?|match\s+points?/i,              "match_points"],
  // Baseball
  [/carreras?\s+totales?|total\s+(?:de\s+)?carreras?|\bcarreras?\b/i,             "runs"],
  // NFL
  [/touchdowns?\s+totales?|total\s+touchdowns?/i,                                 "touchdowns"],
  // Hockey
  [/disparos?\s+(?:al\s+arco|a\s+portería)|shots?\s+on\s+(?:goal|target)/i,       "shots_on_goal"],
  // Goals (most generic — after specifics)
  [/total\s+(?:de\s+)?goles?|goles?\s+totales?|m[aá]s\s*\/\s*menos\s+goles?|over\s*\/\s*under\s+goals?|\bgoles?\b/i, "goals"],
  // H2H (last — catch 1X2, winner, resultado)
  [/resultado\s*(?:final)?|ganador\s+del\s+partido|match\s+result|1\s*x\s*2|winner/i, "h2h"],
];

function classifyAltenarMarket(mkt: AltenarMarket): string | null {
  const label = [mkt.Name, mkt.CategoryName, mkt.TypeName, mkt.MarketTypeName]
    .filter(Boolean).join(" ").toLowerCase();
  for (const [re, market] of MARKET_PATTERNS) {
    if (re.test(label)) return market;
  }
  return null;
}

// ─── Selection parsers ────────────────────────────────────────────────────────

function selectionOdds(s: AltenarSelection): number {
  const n = typeof s.Price === "number" ? s.Price : parseFloat(String(s.Price ?? "0"));
  return isFinite(n) && n >= 1.01 ? n : 0;
}

function activeSelections(mkt: AltenarMarket): AltenarSelection[] {
  return (mkt.Selections ?? []).filter(s => s.Status !== "Suspended" && s.IsActive !== false);
}

function parseH2H(mkt: AltenarMarket): H2HOutcome[] | null {
  const sels = activeSelections(mkt);
  const out: H2HOutcome[] = sels
    .map(s => {
      const odds = selectionOdds(s);
      const name = s.Name ?? "";
      return odds > 0 && name ? { name, odds } : null;
    })
    .filter((x): x is H2HOutcome => x !== null);
  return out.length >= 2 ? out : null;
}

function parseOverUnder(mkt: AltenarMarket): TotalsLine[] {
  const byLine = new Map<number, { over: number; under: number }>();
  for (const s of activeSelections(mkt)) {
    const odds = selectionOdds(s);
    if (odds === 0) continue;
    const name = (s.Name ?? "").toLowerCase();
    const lineMatch = name.match(/(\d+[.,]\d+|\d+)/);
    if (!lineMatch) continue;
    const line = parseFloat(lineMatch[1].replace(",", "."));
    const isOver  = /m[aá]s\s*(?:de)?\s|over|\+|arriba/i.test(name);
    const isUnder = /menos\s*(?:de)?\s|under|-|abajo/i.test(name);
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

// ─── Player prop detection ────────────────────────────────────────────────────

const PROP_STATS: Array<[RegExp, string]> = [
  [/\bpra\b/i, "PRA"],
  [/rebounds?\s*\+\s*assists?/i, "RA"],
  [/points?\s*\+\s*rebounds?/i, "PR"],
  [/points?\s*\+\s*assists?/i, "PA"],
  [/\basistencias?\b|\bassist[s]?\b/i, "AST"],
  [/3[\s-]?pointer[s]?|triples?|\b3pt\b/i, "3PT"],
  [/\brebotes?\b|\brebound[s]?\b/i, "REB"],
  [/block[s]?|tapones?/i, "BLK"],
  [/steal[s]?|robos?/i, "STL"],
  [/\bpuntos?\b|\bpoints?\b/i, "PTS"],
  [/\baces?\b/i, "aces"],
  [/dobles?\s*faltas?|double\s*faults?/i, "double_faults"],
  [/goles?|anytime\s*score/i, "goals"],
  [/disparos?\s+a\s+puerta|shots?\s+on\s+target/i, "sog"],
  [/jonrones?|home\s*runs?/i, "HR"],
  [/strikeouts?|ponches?/i, "K"],
  [/\bhits?\b/i, "H"],
  [/rbis?|carreras?\s*impulsadas?/i, "RBI"],
  [/passing\s+yards?|yardas?\s*de\s*pase/i, "pass_yds"],
  [/rushing\s+yards?|yardas?\s*terrestres?/i, "rush_yds"],
  [/receiving\s+yards?|yardas?\s*de\s*recepci[oó]n/i, "rec_yds"],
  [/touchdowns?/i, "TD"],
  [/saves?\s+hockey|paradas?/i, "saves"],
];

function detectPropStat(label: string): string | null {
  for (const [re, stat] of PROP_STATS) {
    if (re.test(label)) return stat;
  }
  return null;
}

function isPlayerPropMarket(mkt: AltenarMarket): { player: string; stat: string } | null {
  const label = mkt.Name ?? mkt.CategoryName ?? "";
  const parts = label.split(/\s*[-–—]\s*/);
  if (parts.length < 2) return null;
  // "[Player] - [Stat]"
  const stat = detectPropStat(parts[parts.length - 1]);
  if (stat) {
    const player = parts.slice(0, -1).join(" ").trim();
    if (player.length >= 2) return { player, stat };
  }
  // "[Stat] - [Player]"
  const stat2 = detectPropStat(parts[0]);
  if (stat2) {
    const player = parts.slice(1).join(" ").trim();
    if (player.length >= 2) return { player, stat: stat2 };
  }
  return null;
}

function parsePropLines(mkt: AltenarMarket, player: string, stat: string): PlayerPropLine[] {
  const byLine = new Map<number, { over: number; under: number }>();
  for (const s of activeSelections(mkt)) {
    const odds = selectionOdds(s);
    if (odds === 0) continue;
    const name = (s.Name ?? "").toLowerCase();
    const lm = name.match(/(\d+[.,]\d+|\d+)/);
    if (!lm) continue;
    const line = parseFloat(lm[1].replace(",", "."));
    const isOver  = /m[aá]s\s*(?:de)?|over|\+/i.test(name);
    const isUnder = /menos\s*(?:de)?|under|-/i.test(name);
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

// ─── Main parser ──────────────────────────────────────────────────────────────

function parseAltenarResponse(
  data: unknown,
  bookmaker: string,
  sport: Sport,
  isLive: boolean,
): ScrapedEvent[] {
  if (!data || typeof data !== "object") return [];

  const raw = data as AltenarResponse;
  const items: AltenarEvent[] =
    raw.Result ?? raw.Events ?? raw.Data?.Events ?? [];

  if (!Array.isArray(items) || items.length === 0) return [];

  const results: ScrapedEvent[] = [];

  for (const ev of items) {
    const status = String(ev.MatchStatus ?? "").toLowerCase();
    const evIsLive = status === "inprogress" || status === "in_progress" || status.includes("live");
    if (isLive !== evIsLive) continue;

    const home = ev.Home ?? ev.TeamHome ?? "";
    const away = ev.Away ?? ev.TeamAway ?? "";
    const eventName = ev.Name ?? (home && away ? `${home} - ${away}` : "");
    if (!eventName) continue;

    const startTime = ev.StartDate ? new Date(ev.StartDate) : undefined;
    const eventKey  = buildEventKey(sport, eventName, startTime);
    const allMarkets: AltenarMarket[] = [
      ...(ev.Markets ?? []),
      ...(ev.MainMarket ? [ev.MainMarket] : []),
    ];

    for (const mkt of allMarkets) {
      if (!mkt.Selections?.length) continue;

      // ── Player props ──────────────────────────────────────────────────
      const propMeta = isPlayerPropMarket(mkt);
      if (propMeta) {
        const lines = parsePropLines(mkt, propMeta.player, propMeta.stat);
        if (lines.length) {
          results.push({ bookmaker, sport, eventKey, eventName, startTime, isLive, market: "player_props", outcomes: lines });
        }
        continue;
      }

      const market = classifyAltenarMarket(mkt);
      if (!market) continue;

      // ── H2H-style markets (h2h / btts / double_chance / handicap) ────
      if (market === "h2h" || market === "btts" || market === "double_chance" || market === "handicap") {
        const outcomes = parseH2H(mkt);
        if (outcomes) {
          results.push({ bookmaker, sport, eventKey, eventName, startTime, isLive, market, outcomes });
        }
        continue;
      }

      // ── Asian Handicap (TotalsLine: over=home, under=away) ────────────
      if (market === "asian_handicap") {
        const lines = parseOverUnder(mkt);
        if (lines.length) {
          results.push({ bookmaker, sport, eventKey, eventName, startTime, isLive, market: "asian_handicap", outcomes: lines });
        }
        continue;
      }

      // ── O/U markets ───────────────────────────────────────────────────
      const lines = parseOverUnder(mkt);
      if (lines.length) {
        results.push({ bookmaker, sport, eventKey, eventName, startTime, isLive, market, outcomes: lines });
      }
    }
  }

  return results;
}

// ─── Scraper class ────────────────────────────────────────────────────────────

export class AltenarScraper extends BaseScraper {
  readonly name: string;
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "AMERICANFOOTBALL", "ICEHOCKEY", "BASEBALL"];
  private readonly integrationId: string;

  constructor(bookmaker: string, integrationId: string) {
    super();
    this.name = bookmaker;
    this.integrationId = integrationId;

    const proxyUrl = (config.scraperProxies as any).altenar as string | undefined;
    if (proxyUrl) {
      this.http = createProxiedAxios(proxyUrl, 20_000, {
        "Origin":  `https://www.${bookmaker}.es`,
        "Referer": `https://www.${bookmaker}.es/`,
      });
    } else {
      this.http = axios.create({
        timeout: 20_000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept": "application/json, */*",
          "Accept-Language": "es-ES,es;q=0.9",
          "Origin": `https://www.${bookmaker}.es`,
        },
      });
    }
  }

  private buildUrl(sport: Sport, isLive: boolean): string {
    const sportId = ALTENAR_SPORT_IDS[sport] ?? 0;
    if (!sportId) return "";
    const base = `${ALTENAR_CDN}/api/Sportsbook/GetEvents`;
    const params = new URLSearchParams({
      culture: "es-ES",
      integration: this.integrationId,
      sportIds: String(sportId),
      count: "200",
      marketCount: "20",        // request secondary markets per event
      includePrematch: isLive ? "false" : "true",
    });
    if (isLive) params.set("isLive", "true");
    return `${base}?${params}`;
  }

  private async scrapeForSport(sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    const url = this.buildUrl(sport, isLive);
    if (!url) return [];
    try {
      const { data } = await this.http.get(url);
      const events = parseAltenarResponse(data, this.name, sport, isLive);
      const markets = [...new Set(events.map(e => e.market))].join(",");
      this.log(`${isLive ? "live" : "prematch"} ${sport}: ${events.length} events [${markets}]`);
      return events;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 402 || status === 403) {
        this.warn(`${sport} ${isLive ? "live" : "prematch"}: HTTP ${status} — bloqueado (necesita proxy ES)`);
      } else if (!err?.response) {
        this.warn(`${sport} ${isLive ? "live" : "prematch"}: sin respuesta — proxy caído?`);
      } else {
        this.warn(`${sport} ${isLive ? "live" : "prematch"} falló HTTP ${status}`, err?.message);
      }
      return [];
    }
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    if (!config.scraperProxies.altenar) { this.log("Sin ALTENAR_PROXY_URL — necesita proxy ES"); return []; }
    const settled = await Promise.allSettled(this.sports.map(s => this.scrapeForSport(s, true)));
    return settled.flatMap(r => r.status === "fulfilled" ? r.value : []);
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (!config.scraperProxies.altenar) { this.log("Sin ALTENAR_PROXY_URL — necesita proxy ES"); return []; }
    const settled = await Promise.allSettled(this.sports.map(s => this.scrapeForSport(s, false)));
    return settled.flatMap(r => r.status === "fulfilled" ? r.value : []);
  }
}
