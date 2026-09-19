/**
 * William Hill España — NGS REST API scraper.
 *
 * Flow:
 *   1. For each sport × state (live/prematch) × marketType:
 *      GET /data/ngs/matches-competitions/matches/es-es/{sportCode}
 *          ?source=ngs@2.79.2&sortKey=competition&state={IP|PM}&marketType={name}
 *   2. Parse competitions[].events[].markets[].selections
 *   3. Convert fractional odds (currentPriceNum / currentPriceDen + 1)
 *   4. Emit ScrapedEvent per market line
 *
 * Key findings:
 *   - Each API call returns events matching the marketType prefix, with ALL their markets.
 *   - Basketball, baseball, hockey, NFL: one "Ganador del partido" call returns h2h + handicap + totals.
 *   - Football: each market type requires a separate call.
 *   - sort=-- markets use name-based detection; selections use fb="-" with name-embedded values.
 */

import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine } from "../types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SocksProxyAgent } = require("socks-proxy-agent");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require("axios").default ?? require("axios");

const NGS_BASE    = "https://sports.williamhill.es/data/ngs/matches-competitions/matches/es-es";
const BETTING_BASE = "https://sports.williamhill.es/betting/es-es";
const NGS_SOURCE  = "ngs@2.79.2";

// OpenBet sport IDs (verified from /inPlay/configuration endpoint 2026-09-17)
const SPORT_CODES: Partial<Record<Sport, string>> = {
  FOOTBALL:         "OB_SP9",
  TENNIS:           "OB_SP24",
  BASKETBALL:       "OB_SP27",
  AMERICANFOOTBALL: "OB_SP1",  // OB_SP56 is Table Tennis — do not use
  ICEHOCKEY:        "OB_SP26",
  BASEBALL:         "OB_SP2",
};

// URL path segment for each sport on WH Spain (for event deep-links)
const SPORT_SLUGS: Partial<Record<Sport, string>> = {
  FOOTBALL:         "f%C3%BAtbol",
  TENNIS:           "tenis",
  BASKETBALL:       "baloncesto",
  AMERICANFOOTBALL: "futbol-americano",
  ICEHOCKEY:        "hockey-hielo",
  BASEBALL:         "beisbol",
};

// Per-sport market requests: each entry triggers one API call.
// For non-football sports, "Ganador del partido" returns handicap + totals in the same response.
// Football requires explicit additional calls for each secondary market type.
const SPORT_MARKET_REQUESTS: Partial<Record<Sport, Array<{ marketType: string; key: string }>>> = {
  FOOTBALL: [
    { marketType: "Ganador del partido",      key: "h2h" },
    { marketType: "Doble oportunidad",        key: "double_chance" },
    { marketType: "Ambos equipos marcador",   key: "btts" },
    { marketType: "Gol en ambos tiempos",     key: "btts" },
    { marketType: "Total de goles",           key: "goals" },
    { marketType: "Hándicap asiático",        key: "asian_handicap" },
    { marketType: "Hándicap",                 key: "handicap" },
    { marketType: "1er Tiempo - Total de goles", key: "h1_goals" },
    { marketType: "2do Tiempo - Total de goles", key: "h2_goals" },
    { marketType: "Tiros de esquina",         key: "corners" },
    { marketType: "Tarjetas",                 key: "cards" },
  ],
  BASKETBALL: [
    { marketType: "Ganador del partido", key: "h2h" },
    // NGS response also includes: handicap, match_points, quarter/half totals
  ],
  TENNIS: [
    { marketType: "Ganador del partido", key: "h2h" },
    // NGS response also includes: set winners (TSW1-3), per-set game totals (TS1G-3G), tie-break
  ],
  AMERICANFOOTBALL: [
    { marketType: "Ganador del partido", key: "h2h" },
    // NGS response also includes: handicap, match_points
  ],
  ICEHOCKEY: [
    { marketType: "Ganador del partido", key: "h2h" },
    // NGS response also includes: handicap (puck line), goals
  ],
  BASEBALL: [
    { marketType: "Ganador del partido", key: "h2h" },
    // NGS response also includes: handicap (run line), runs
  ],
};

// Known sort codes → internal market keys
const SORT_TO_KEY: Record<string, string> = {
  // Match result
  MR:    "h2h",          // 3-way match result (football)
  HH:    "h2h",          // 2-way head-to-head (basketball, tennis, etc.)
  DC:    "double_chance",
  BTS:   "btts",
  // Handicap
  AH:    "asian_handicap",
  MH:    "handicap",
  WH:    "handicap",
  // Totals — sport-specific key resolved by resolveKey()
  TG:    "_totals",      // goals / points / games / runs (resolved per sport)
  HL:    "_totals",      // basketball high/low totals
  HHTG:  "h1_goals",    // football 1st-half total goals
  H2TG:  "h2_goals",    // football 2nd-half total goals
  // Corners / cards
  CRN:   "corners",
  ACRN:  "corners",      // alternative corners sort code
  BK:    "cards",
  YC:    "yellow_cards",
  RC:    "red_cards",
  // Tennis
  TSW1:  "s1_h2h",      // set 1 winner
  TSW2:  "s2_h2h",      // set 2 winner
  TSW3:  "s3_h2h",      // set 3 winner
  TS1G:  "s1_games",    // set 1 total games O/U
  TS2G:  "s2_games",    // set 2 total games O/U
  TS3G:  "s3_games",    // set 3 total games O/U
  TNTB:  "tie_break",   // tie-break in match
  // Basketball quarters / halves
  BKQTR1: "q1_points",
  BKQTR2: "q2_points",
  BKQTR3: "q3_points",
  BKQTR4: "q4_points",
  BKH1TP: "h1_points",
  BKH2TP: "h2_points",
};

// Detect market type from Spanish market name (for sort=-- markets with no sort code)
function detectByName(name: string): string | null {
  // Handicap variants (check specifics before generic "hándicap")
  if (/puntos con h[áa]ndicap/i.test(name)) return "handicap";     // basketball
  if (/h[áa]ndicap de carreras/i.test(name)) return "handicap";    // baseball run line
  if (/puck line/i.test(name)) return "handicap";                   // hockey
  if (/h[áa]ndicap asi[áa]tico/i.test(name)) return "asian_handicap";
  if (/\bh[áa]ndicap\b/i.test(name)) return "handicap";            // NFL / generic
  // Half-time totals (before generic "total de goles")
  if (/(?:primer[ao]?|1er?|1[aªº])\s*(?:tiempo|mitad|parte).*(?:total\s+(?:de\s+)?goles?|goles?\s+totales?)|(?:total\s+(?:de\s+)?goles?|goles?\s+totales?).*(?:primer[ao]?|1er?|1[aªº])\s*(?:tiempo|mitad|parte)/i.test(name)) return "h1_goals";
  if (/(?:segundo?|2do?|2[aªº])\s*(?:tiempo|mitad|parte).*(?:total\s+(?:de\s+)?goles?|goles?\s+totales?)|(?:total\s+(?:de\s+)?goles?|goles?\s+totales?).*(?:segundo?|2do?|2[aªº])\s*(?:tiempo|mitad|parte)/i.test(name)) return "h2_goals";
  // Totals (specific before generic "total")
  if (/total de puntos del partido/i.test(name)) return "_totals";  // NFL
  if (/total de puntos/i.test(name)) return "_totals";              // basketball
  if (/total de carreras/i.test(name)) return "_totals";            // baseball
  if (/total de goles en el partido/i.test(name)) return "_totals"; // hockey (incl OT)
  if (/total de goles/i.test(name)) return "_totals";               // football
  if (/total de juegos/i.test(name)) return "_totals";              // tennis
  if (/total de sets/i.test(name)) return "sets";                   // tennis
  // Tennis set winners
  if (/ganador\s*(?:del\s*)?(?:1er?|primer)\s*set/i.test(name)) return "s1_h2h";
  if (/ganador\s*(?:del\s*)?(?:2do?|segundo)\s*set/i.test(name)) return "s2_h2h";
  if (/ganador\s*(?:del\s*)?(?:3er?|tercer)\s*set/i.test(name)) return "s3_h2h";
  // Basketball quarters / halves
  if (/(?:primer|1er?)\s*cuarto/i.test(name)) return "q1_points";
  if (/(?:segundo|2do?)\s*cuarto/i.test(name)) return "q2_points";
  if (/(?:tercer|3er?)\s*cuarto/i.test(name)) return "q3_points";
  if (/(?:cuarto|4to?)\s*cuarto/i.test(name)) return "q4_points";
  if (/(?:primer[ao]?|1er?|1[aªº])\s*mitad.*puntos?|puntos?.*(?:primer[ao]?|1er?|1[aªº])\s*mitad/i.test(name)) return "h1_points";
  if (/(?:segundo?|2do?|2[aªº])\s*mitad.*puntos?|puntos?.*(?:segundo?|2do?|2[aªº])\s*mitad/i.test(name)) return "h2_points";
  // BTTS / other football markets
  if (/ambos equipos marcad/i.test(name)) return "btts";
  if (/ambos marcan/i.test(name)) return "btts";
  if (/doble oportunidad/i.test(name)) return "double_chance";
  return null;
}

// Markets that use H2HOutcome[] (binary/ternary winner with no numeric line)
const BINARY_MARKET_KEYS = new Set([
  "h2h", "double_chance", "btts",
  "s1_h2h", "s2_h2h", "s3_h2h", "tie_break", "h1_h2h",
]);

function resolveKey(baseKey: string, sport: Sport): string {
  if (baseKey !== "_totals") return baseKey;
  if (sport === "FOOTBALL" || sport === "ICEHOCKEY") return "goals";
  if (sport === "BASKETBALL" || sport === "AMERICANFOOTBALL") return "match_points";
  if (sport === "TENNIS") return "games";
  if (sport === "BASEBALL") return "runs";
  return "goals";
}

function getProxy(): string {
  return process.env.ROUTER_PROXY_URL ?? "";
}

// ── NGS API types ─────────────────────────────────────────────────────────────

interface NgsSelection {
  id: string;
  name: string;
  currentPriceNum: number;
  currentPriceDen: number;
  fbResult: string;  // "H" | "D" | "A" | "-" (for sort=-- markets)
  status: string;    // "A" = active, "S" = suspended
  active: boolean;
  displayed: boolean;
}

interface NgsMarket {
  id: string;
  name: string;
  sort: string;          // OpenBet sort code: "MR" | "HH" | "TG" | "AH" | "--" | etc.
  status: string;
  active: boolean;
  displayed: boolean;
  hcapValue: number | null;
  selections: NgsSelection[];
}

interface NgsEvent {
  id: string;
  name: string;
  pathname: string;
  startDateTime: string;
  isInPlay: boolean;
  state: string;
  status: string;
  active: boolean;
  displayed: boolean;
  settled: boolean;
  markets: NgsMarket[];
}

interface NgsCompetition {
  id: string;
  name: string;
  events: NgsEvent[];
}

interface NgsResponse {
  competitions: NgsCompetition[];
  hasMore?: boolean;
  page?: number;
  count?: number;
}

// ── API fetch ─────────────────────────────────────────────────────────────────

const PREMATCH_MAX_PAGES  = 5;
const PREMATCH_MAX_DAYS   = 2;  // only events in the next 2 days

async function fetchNgsPage(
  sportCode: string,
  state: "IP" | "PM",
  marketType: string,
  page: number,
  proxy?: string,
): Promise<NgsResponse & { hasMore?: boolean }> {
  const agentOpts = proxy ? { httpAgent: new SocksProxyAgent(proxy), httpsAgent: new SocksProxyAgent(proxy) } : {};
  const resp = await axios.get(`${NGS_BASE}/${sportCode}`, {
    ...agentOpts,
    timeout: 20_000,
    params: {
      source: NGS_SOURCE,
      sortKey: "competition",
      state,
      marketType,
      availableDays: true,
      ...(page > 0 ? { page } : {}),
    },
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "application/json",
      "Accept-Language": "es-ES,es;q=0.9",
      Referer: "https://sports.williamhill.es/betting/es-es/en-directo/all",
    },
  });
  return resp.data as NgsResponse & { hasMore?: boolean };
}

async function fetchNgsMarkets(
  sportCode: string,
  state: "IP" | "PM",
  marketType: string,
  proxy?: string,
): Promise<NgsResponse> {
  if (state === "IP") {
    return fetchNgsPage(sportCode, state, marketType, 0, proxy);
  }

  const cutoff = Date.now() + PREMATCH_MAX_DAYS * 86_400_000;
  const allComps = new Map<string, NgsCompetition>();

  for (let page = 0; page < PREMATCH_MAX_PAGES; page++) {
    const data = await fetchNgsPage(sportCode, state, marketType, page, proxy);
    const comps = data.competitions ?? [];
    let anyEventWithinCutoff = false;

    for (const comp of comps) {
      const withinEvents: NgsEvent[] = [];
      for (const ev of comp.events ?? []) {
        const evTime = ev.startDateTime ? new Date(ev.startDateTime).getTime() : 0;
        if (evTime <= cutoff) {
          withinEvents.push(ev);
          anyEventWithinCutoff = true;
        }
      }
      if (withinEvents.length > 0) {
        const existing = allComps.get(comp.id);
        if (existing) existing.events.push(...withinEvents);
        else allComps.set(comp.id, { ...comp, events: withinEvents });
      }
    }

    if (!data.hasMore || !anyEventWithinCutoff) break;
  }

  return { competitions: [...allComps.values()] };
}

// ── Parse NGS response ─────────────────────────────────────────────────────────

function parseNgsResponse(
  ngsData: NgsResponse,
  sport: Sport,
  requestedKey: string,
  isLive: boolean,
  sportSlug: string,
): ScrapedEvent[] {
  const results: ScrapedEvent[] = [];

  for (const comp of ngsData.competitions ?? []) {
    for (const event of comp.events ?? []) {
      if (!event.active || !event.displayed || event.settled || event.status !== "A") continue;

      // WH uses U+208B SUBSCRIPT MINUS as team separator (e.g. "Kalamata ₋ Larissa").
      // Replace it and other Unicode dashes with " v " so splitTeams can split correctly.
      const rawName = event.name.replace(/[₋−–—]/g, " v ").replace(/\s+/g, " ").trim();
      const eventName = rawName;
      if (!eventName) continue;

      // Skip virtual/fantasy events: WH runs simulcast games where team names carry
      // player/city handles in parentheses, e.g. "Arsenal (Sebastian) v Man City (Splinter)".
      // Real team qualifiers (U21, W, II) are ≤3 chars or contain digits; virtual handles are 4+ letters.
      const virtualParens = rawName.match(/\(([A-Za-z]{4,})\)/g);
      if (virtualParens && virtualParens.length >= 2) continue;

      const startTime = event.startDateTime ? new Date(event.startDateTime) : undefined;
      const eventKey  = buildEventKey(sport, eventName, startTime);
      const eventUrl  = sportSlug ? `${BETTING_BASE}/${sportSlug}/${event.pathname}` : undefined;

      for (const market of event.markets ?? []) {
        if (!market.active || !market.displayed || market.status !== "A") continue;

        // Resolve market key: prefer sort code mapping, fall back to name detection
        const sortKey = SORT_TO_KEY[market.sort] ?? detectByName(market.name);
        if (!sortKey) {
          // Log unknown sort codes — helps discover new market codes (e.g. NBA quarters)
          if (process.env.WH_DEBUG_MARKETS === "1") {
            console.debug(`[wh-debug] unknown sort="${market.sort}" name="${market.name}" sport=${sport}`);
          }
          continue;
        }
        const marketKey = resolveKey(sortKey, sport);

        // Filter out football "win by margin" markets that look like h2h but aren't
        if (marketKey === "h2h" && /ventaja/i.test(market.name)) continue;

        const activeSels = (market.selections ?? []).filter(
          s => s.active && s.displayed && s.status === "A"
            && s.currentPriceDen > 0 && s.currentPriceNum > 0,
        );
        if (activeSels.length < 2) continue;

        const toDecimal = (s: NgsSelection) =>
          parseFloat((s.currentPriceNum / s.currentPriceDen + 1).toFixed(4));

        if (BINARY_MARKET_KEYS.has(marketKey)) {
          const outcomes: H2HOutcome[] = activeSels.map(s => ({
            name: s.name || (s.fbResult === "H" ? "1" : s.fbResult === "D" ? "X" : "2"),
            odds: toDecimal(s),
          }));
          if (outcomes.length < 2) continue;
          results.push({
            bookmaker: "williamhill",
            sport,
            eventKey,
            eventName,
            league: comp.name,
            isLive,
            startTime,
            market: marketKey,
            outcomes,
            url: eventUrl,
          });

        } else if (marketKey === "asian_handicap" || marketKey === "handicap") {
          // Group selections by absolute handicap value → one TotalsLine per line
          const lines = new Map<string, TotalsLine>();
          for (const s of activeSels) {
            const odds = toDecimal(s);
            // Extract line from hcapValue or from selection name "{Team} [+-]X.5"
            let lineVal: number | null = null;
            if (market.hcapValue != null) {
              lineVal = Math.abs(market.hcapValue);
            } else {
              const m = s.name.match(/([+-]\d+\.?\d*)\s*$/) ?? s.name.match(/(\d+\.?\d*)/);
              lineVal = m ? Math.abs(parseFloat(m[1])) : null;
            }
            if (lineVal == null) continue;
            const key = String(lineVal);
            if (!lines.has(key)) lines.set(key, { line: lineVal, over: 0, under: 0 });
            const tl = lines.get(key)!;

            if (s.fbResult === "H") tl.over = odds;
            else if (s.fbResult === "A") tl.under = odds;
            else {
              // sort=-- markets: fb="-"; determine favored/underdog from sign in name
              const signMatch = s.name.match(/\s([+-]\d+\.?\d*)\s*$/);
              if (signMatch) {
                const v = parseFloat(signMatch[1]);
                if (v < 0) tl.over = odds;   // Negative = favored team (must cover)
                else if (v > 0) tl.under = odds;  // Positive = underdog (getting points)
              }
            }
          }
          for (const tl of lines.values()) {
            if (!tl.over || !tl.under) continue;
            results.push({
              bookmaker: "williamhill",
              sport,
              eventKey,
              eventName,
              league: comp.name,
              isLive,
              startTime,
              market: marketKey,
              outcomes: [tl],
              url: eventUrl,
            });
          }

        } else {
          // O/U markets: goals, match_points, games, runs, corners, cards, etc.
          // For sort=-- markets, fb="-": use "Más de X" / "Menos de X" in selection name.
          // For regular sort codes, fb=H=Over / A=Under.
          const lines = new Map<string, TotalsLine>();
          for (const s of activeSels) {
            const odds = toDecimal(s);
            const m = s.name.match(/(\d+\.?\d*)/);
            if (!m) continue;
            const line = parseFloat(m[1]);
            const key = String(line);
            if (!lines.has(key)) lines.set(key, { line, over: 0, under: 0 });
            const tl = lines.get(key)!;
            if (s.fbResult === "H" || /m[aá]s\s*de|^over\b/i.test(s.name)) tl.over = odds;
            else if (s.fbResult === "A" || s.fbResult === "L" || /menos\s*de|^under\b/i.test(s.name)) tl.under = odds;
          }
          for (const tl of lines.values()) {
            if (!tl.over || !tl.under) continue;
            results.push({
              bookmaker: "williamhill",
              sport,
              eventKey,
              eventName,
              league: comp.name,
              isLive,
              startTime,
              market: marketKey,
              outcomes: [tl],
              url: eventUrl,
            });
          }
        }
      }
    }
  }

  return results;
}

// ── Scraper class ──────────────────────────────────────────────────────────────

export class WilliamHillScraper extends BaseScraper {
  readonly name = "williamhill";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "BASEBALL", "AMERICANFOOTBALL", "ICEHOCKEY"];

  private async scrapeSportState(
    sport: Sport,
    state: "IP" | "PM",
    isLive: boolean,
  ): Promise<ScrapedEvent[]> {
    const sportCode = SPORT_CODES[sport];
    if (!sportCode) return [];

    const sportSlug = SPORT_SLUGS[sport] ?? "";
    const proxy = getProxy() || undefined;
    const results: ScrapedEvent[] = [];
    const requests = SPORT_MARKET_REQUESTS[sport] ?? [{ marketType: "Ganador del partido", key: "h2h" }];

    for (const { marketType, key } of requests) {
      try {
        const data = await fetchNgsMarkets(sportCode, state, marketType, proxy);
        const events = parseNgsResponse(data, sport, key, isLive, sportSlug);
        results.push(...events);
      } catch (err) {
        this.warn(`WH ${isLive ? "LIVE" : "PRE"} ${sport}/${marketType}`, err);
      }
    }

    return results;
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    const all = await Promise.all(
      this.sports.map(sport => this.scrapeSportState(sport, "IP", true)),
    );
    const flat = all.flat();

    const seen = new Set<string>();
    const deduped = flat.filter(ev => {
      const o0 = ev.outcomes[0];
      const lineKey = o0 && "line" in o0 ? String((o0 as TotalsLine).line) : "";
      const k = `${ev.eventKey}|${ev.market}|${lineKey}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });

    const mktCounts = deduped.reduce((acc, e) => { acc[e.market] = (acc[e.market] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    this.log(`WH LIVE: ${deduped.length} markets — ${Object.entries(mktCounts).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    return deduped;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    const all = await Promise.all(
      this.sports.map(sport => this.scrapeSportState(sport, "PM", false)),
    );
    const flat = all.flat();

    const seen = new Set<string>();
    const deduped = flat.filter(ev => {
      const o0 = ev.outcomes[0];
      const lineKey = o0 && "line" in o0 ? String((o0 as TotalsLine).line) : "";
      const k = `${ev.eventKey}|${ev.market}|${lineKey}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });

    const mktCounts = deduped.reduce((acc, e) => { acc[e.market] = (acc[e.market] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    this.log(`WH PRE: ${deduped.length} markets — ${Object.entries(mktCounts).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    return deduped;
  }
}
