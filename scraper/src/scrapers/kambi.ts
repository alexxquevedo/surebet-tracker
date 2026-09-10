/**
 * Kambi B2B platform scraper — covers multiple Spanish bookmakers from one class.
 *
 * Bookmakers on Kambi: LeoVegas, 888sport, Casumo, Unibet ES, Kirolbet, Marca, JokerBet
 * API: eu-offering.kambicdn.org — requires Spanish ISP sticky proxy
 *
 * Markets scraped:
 *   h2h, handicap, btts, double_chance, asian_handicap (TotalsLine),
 *   goals/corners/cards (O/U TotalsLine), sets/games (tennis), player_props
 *
 * Usage: new KambiScraper("leovegas",  "leovegas")
 *        new KambiScraper("888sport",  "888sport")
 *        new KambiScraper("jokerbet",  "jokerbet")   ← clientId TBD via proxy
 */

import axios from "axios";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import { config } from "../config";
import { createProxiedAxios } from "./proxy-helper";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine, PlayerPropLine } from "../types";

const SPORT_PATH: Partial<Record<Sport, string>> = {
  FOOTBALL:         "football",
  TENNIS:           "tennis",
  BASKETBALL:       "basketball",
  AMERICANFOOTBALL: "american-football",
  ICEHOCKEY:        "ice-hockey",
  BASEBALL:         "baseball",
};

const KAMBI_CDN = "https://eu-offering.kambicdn.org";

// ─── Kambi type declarations ──────────────────────────────────────────────────

interface KambiOutcome {
  label?: string;
  englishLabel?: string;
  type?: string;      // e.g. "OT_ONE", "OT_CROSS", "OT_TWO", "OT_OVER", "OT_UNDER", "OT_YES", "OT_NO"
  odds?: number;      // in thousandths: 1700 = 1.70
  line?: number;      // for AH: in thousandths (-500 = -0.5)
  participant?: string;
}

interface KambiBetOfferCriterion {
  id?: number | string;
  label?: string;
  englishLabel?: string;
  type?: string;      // "MATCH_RESULT", "OVER_UNDER", "BOTH_TEAMS_TO_SCORE", etc.
  occurrenceType?: string;
  sport?: string;
}

interface KambiBetOffer {
  id?: number;
  main?: boolean;
  criterion?: KambiBetOfferCriterion;
  betOfferType?: { id?: number; name?: string };
  outcomes?: KambiOutcome[];
  suspended?: boolean;
  open?: boolean;
  closed?: boolean;
  // Asian Handicap: line stored here in thousandths
  line?: number;
  // Range bet offer: multiple lines (one per AH/OU step)
  rangeBetOffers?: KambiBetOffer[];
}

interface KambiEventData {
  id: number;
  name?: string;
  englishName?: string;
  homeName?: string;
  awayName?: string;
  sport?: string;
  state?: string; // "STARTED" | "NOT_STARTED"
  start?: string;
  participants?: Array<{ name: string; type?: string }>;
}

interface KambiItem {
  event?: KambiEventData;
  betOffers?: KambiBetOffer[];
  mainBetOffer?: KambiBetOffer;
  // Range bet offers (secondary markets returned with rangeBetOffers=true)
  rangeBetOffers?: KambiBetOffer[];
}

// ─── Market classification ────────────────────────────────────────────────────

// Kambi criterion type → our market key
// Priority order matters — more specific first
const CRITERION_TO_MARKET: Array<[RegExp, string]> = [
  [/BOTH_TEAMS_TO_SCORE|BOTH_TEAMS_SCORE/i,                "btts"],
  [/DOUBLE_CHANCE/i,                                        "double_chance"],
  [/ASIAN_HANDICAP/i,                                       "asian_handicap"],
  [/EUROPEAN_HANDICAP|HANDICAP/i,                           "handicap"],
  [/MATCH_RESULT|MATCH_WINNER|FULL_TIME_RESULT|1_1$/i,      "h2h"],
  [/CORNER/i,                                               "corners"],
  [/YELLOW_CARD|BOOKING/i,                                  "yellow_cards"],
  [/RED_CARD/i,                                             "red_cards"],
  [/CARD/i,                                                 "cards"],
  [/SHOT/i,                                                 "shots"],
  [/HALF_TIME/i,                                            "h1_goals"],
  [/ACE/i,                                                  "aces"],
  [/DOUBLE_FAULT/i,                                         "double_faults"],
  [/GAME/i,                                                 "games"],
  [/SET/i,                                                  "sets"],
  [/OVER_UNDER|GOALS_OVER_UNDER/i,                          "goals"],
  [/POINTS/i,                                               "match_points"],
  [/RUN/i,                                                  "runs"],
  [/STRIKEOUT/i,                                            "strikeouts"],
  [/TOUCHDOWN/i,                                            "touchdowns"],
  [/SAVE/i,                                                 "goalie_saves"],
  [/PLAYER|ANYTIME_SCORER|FIRST_SCORER/i,                   "player_props"],
];

// Label → market (when criterion.type isn't enough)
const LABEL_TO_MARKET: Array<[RegExp, string]> = [
  [/ambos\s+marcan|both\s+teams\s+score|btts/i,             "btts"],
  [/doble\s+oportunidad|double\s+chance/i,                  "double_chance"],
  [/h[aá]ndicap\s+asi[aá]tico|asian\s+handicap/i,           "asian_handicap"],
  [/h[aá]ndicap/i,                                          "handicap"],
  [/c[oó]rne?rs?|esquina/i,                                 "corners"],
  [/tarjetas?\s+amarillas?/i,                               "yellow_cards"],
  [/tarjetas?\s+rojas?/i,                                   "red_cards"],
  [/tarjetas?/i,                                            "cards"],
  [/disparos?|tiros?|shots?/i,                              "shots"],
  [/primera\s+mitad|half[\s-]time|1ª\s*parte/i,             "h1_goals"],
  [/segunda\s+mitad|2nd\s+half|2ª\s*parte/i,                "h2_goals"],
  [/\baces?\b/i,                                            "aces"],
  [/dobles?\s+faltas?/i,                                    "double_faults"],
  [/\bjuegos?\b/i,                                          "games"],
  [/\bsets?\b/i,                                            "sets"],
  [/goles?\s+totales?|total\s+goles?|over\s*\/\s*under\s+goals?/i, "goals"],
  [/total\s+puntos?|points?\s+totales?/i,                   "match_points"],
  [/carreras?\s+totales?/i,                                 "runs"],
  [/strikeouts?|ponches?/i,                                 "strikeouts"],
  [/1\s*x\s*2|resultado\s+final|match\s+result/i,           "h2h"],
];

function classifyBetOffer(offer: KambiBetOffer): string | null {
  const criterionType = offer.criterion?.type ?? "";
  const label = (offer.criterion?.label ?? offer.criterion?.englishLabel ?? offer.betOfferType?.name ?? "").toLowerCase();

  for (const [re, market] of CRITERION_TO_MARKET) {
    if (re.test(criterionType)) return market;
  }
  for (const [re, market] of LABEL_TO_MARKET) {
    if (re.test(label)) return market;
  }
  return null;
}

// ─── Kambi player prop stat classification ────────────────────────────────────

const KAMBI_PROP_STATS: Array<[RegExp, string]> = [
  [/\bpra\b|points?\s*\+\s*rebounds?\s*\+\s*assists?/i, "PRA"],
  [/rebounds?\s*\+\s*assists?/i,                          "RA"],
  [/points?\s*\+\s*rebounds?/i,                           "PR"],
  [/points?\s*\+\s*assists?/i,                            "PA"],
  [/assists?|asistencias?/i,                              "AST"],
  [/3[\s-]?pointer[s]?|triples?|3pt/i,                   "3PT"],
  [/rebounds?|rebotes?/i,                                 "REB"],
  [/block[s]?|tapones?/i,                                 "BLK"],
  [/steal[s]?|robos?/i,                                   "STL"],
  [/turnover[s]?|pérdidas?/i,                             "TOV"],
  [/double[\s-]double/i,                                  "DD"],
  [/triple[\s-]double/i,                                  "TD_DOUBLE"],
  [/points?|puntos?/i,                                    "PTS"],
  // Soccer
  [/goles?|goals?\s+anytime|anytime\s+score/i,            "goals"],
  [/shots?\s+on\s+(target|goal)|disparos?\s+a\s+puerta/i, "sog"],
  [/shots?\s+total|disparos?\s+totales?/i,                "shots"],
  [/pases?|passes?/i,                                     "passes"],
  [/tackles?|entradas?/i,                                 "tackles"],
  // Tennis
  [/aces?/i,                                              "aces"],
  [/double\s+fault[s]?|dobles?\s+faltas?/i,               "double_faults"],
  [/games?\s+won|juegos?\s+ganados?/i,                    "games_won"],
  // Baseball
  [/home\s+run[s]?|jonrones?/i,                           "HR"],
  [/strikeout[s]?|ponches?/i,                             "K"],
  [/\bhits?\b/i,                                          "H"],
  [/rbi[s]?|carreras?\s+impulsadas?/i,                    "RBI"],
  [/\bruns?\b/i,                                          "runs"],
  // NFL
  [/passing\s+yards?|yardas?\s+de\s+pase/i,              "pass_yds"],
  [/rushing\s+yards?|yardas?\s+terrestres?/i,             "rush_yds"],
  [/receiving\s+yards?|yardas?\s+de\s+recepci[oó]n/i,    "rec_yds"],
  [/receptions?|recepciones?/i,                           "REC"],
  [/touchdowns?/i,                                        "TD"],
  // Ice Hockey
  [/shots?\s+on\s+goal\s*(hockey)?|disparos?\s+arco/i,   "sog"],
  [/saves?|paradas?/i,                                    "saves"],
  [/hockey\s+points?/i,                                   "hockey_pts"],
];

function parsePropStat(label: string): string | null {
  for (const [re, stat] of KAMBI_PROP_STATS) {
    if (re.test(label)) return stat;
  }
  return null;
}

// ─── Kambi odds converter ─────────────────────────────────────────────────────

function kOdds(raw: unknown): number {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? "0"));
  if (!isFinite(n) || n <= 0) return 0;
  return n >= 100 ? n / 1000 : n; // Kambi returns thousandths; small values already decimal
}

function kLine(raw: unknown): number {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? "0"));
  return isFinite(n) ? n / 1000 : 0; // lines in thousandths: -500 → -0.5
}

// ─── Single bet offer parser ──────────────────────────────────────────────────

function parseBetOffer(
  offer: KambiBetOffer,
  market: string,
  bookmaker: string,
  sport: Sport,
  eventKey: string,
  eventName: string,
  league: string | undefined,
  startTime: Date | undefined,
  isLive: boolean,
  homeName: string,
  awayName: string,
): ScrapedEvent[] {
  if (offer.suspended || offer.closed) return [];
  const outcomes = offer.outcomes ?? [];

  // ── H2H-style markets (h2h / btts / double_chance / handicap) ─────────────
  if (market === "h2h" || market === "btts" || market === "double_chance" || market === "handicap") {
    const h2h: H2HOutcome[] = outcomes.map(o => {
      const odds = kOdds(o.odds);
      if (odds < 1.01) return null;
      let name = o.englishLabel ?? o.label ?? String(o.type ?? "");
      // Normalise Kambi type codes to readable names
      if (name === "OT_ONE" || name === "1")   name = "1";
      if (name === "OT_CROSS" || name === "X") name = "X";
      if (name === "OT_TWO" || name === "2")   name = "2";
      if (name === "OT_YES")                   name = "Yes";
      if (name === "OT_NO")                    name = "No";
      if (name === "OT_ONE_OR_CROSS")          name = "1X";
      if (name === "OT_CROSS_OR_TWO")          name = "X2";
      if (name === "OT_ONE_OR_TWO")            name = "12";
      if (!name) return null;
      return { name, odds };
    }).filter((x): x is H2HOutcome => x !== null);
    if (h2h.length < 2) return [];
    return [{ bookmaker, sport, eventKey, eventName, league, startTime, isLive, market, outcomes: h2h }];
  }

  // ── Asian Handicap (TotalsLine: line=offset, over=home, under=away) ───────
  if (market === "asian_handicap") {
    const lines: TotalsLine[] = [];
    // Kambi may return AH as range bet offers (each rangeBetOffer = one line)
    const subOffers = offer.rangeBetOffers?.length ? offer.rangeBetOffers : [offer];
    for (const sub of subOffers) {
      const lineVal = kLine(sub.line ?? offer.line);
      const subOutcomes = sub.outcomes ?? [];
      const homeOut = subOutcomes.find(o => o.type === "OT_ONE" || /home|1$/i.test(o.label ?? ""));
      const awayOut = subOutcomes.find(o => o.type === "OT_TWO" || /away|2$/i.test(o.label ?? ""));
      if (!homeOut || !awayOut) continue;
      const homeOdds = kOdds(homeOut.odds);
      const awayOdds = kOdds(awayOut.odds);
      if (homeOdds < 1.01 || awayOdds < 1.01) continue;
      lines.push({ line: lineVal, over: homeOdds, under: awayOdds });
    }
    if (!lines.length) return [];
    return [{ bookmaker, sport, eventKey, eventName, league, startTime, isLive, market: "asian_handicap", outcomes: lines }];
  }

  // ── Over/Under markets (goals, corners, cards, shots, sets, games, …) ─────
  {
    const byLine = new Map<number, { over: number; under: number }>();
    const subOffers = offer.rangeBetOffers?.length ? offer.rangeBetOffers : [offer];
    for (const sub of subOffers) {
      const subOutcomes = sub.outcomes ?? [];
      const lineFromOffer = kLine(sub.line ?? 0);
      for (const o of subOutcomes) {
        const odds = kOdds(o.odds);
        if (odds < 1.01) continue;
        const t = String(o.type ?? "").toUpperCase();
        const isOver  = t === "OT_OVER"  || /over|más\s*de|plus\s*de|\bsobre\b/i.test(o.label ?? "");
        const isUnder = t === "OT_UNDER" || /under|menos\s*de|moins\s*de|\bbajo\b/i.test(o.label ?? "");
        if (!isOver && !isUnder) continue;
        // Line resolution: from outcome label or from offer.line
        const labelMatch = (o.label ?? "").match(/(\d+[.,]\d+|\d+)/);
        const line = labelMatch ? parseFloat(labelMatch[1].replace(",", ".")) : lineFromOffer;
        if (!line && line !== 0) continue;
        const cur = byLine.get(line) ?? { over: 0, under: 0 };
        if (isOver  && odds > cur.over)  cur.over  = odds;
        if (isUnder && odds > cur.under) cur.under = odds;
        byLine.set(line, cur);
      }
    }
    const totals: TotalsLine[] = [...byLine.entries()]
      .filter(([, { over, under }]) => over >= 1.01 && under >= 1.01)
      .map(([line, { over, under }]) => ({ line, over, under }));
    if (!totals.length) return [];
    return [{ bookmaker, sport, eventKey, eventName, league, startTime, isLive, market, outcomes: totals }];
  }
}

// ─── Player prop parser ───────────────────────────────────────────────────────

function parsePlayerPropOffer(
  offer: KambiBetOffer,
  bookmaker: string,
  sport: Sport,
  eventKey: string,
  eventName: string,
  league: string | undefined,
  startTime: Date | undefined,
  isLive: boolean,
): ScrapedEvent[] {
  const criterionLabel = offer.criterion?.label ?? offer.criterion?.englishLabel ?? "";
  // Kambi format: "[Player Name] – [Stat] ([line])" or similar
  const dashIdx = criterionLabel.indexOf(" – ");
  const altDash = criterionLabel.indexOf(" - ");
  const sepIdx = dashIdx >= 0 ? dashIdx : altDash;
  if (sepIdx < 2) return [];

  const playerName = criterionLabel.slice(0, sepIdx).trim();
  const statPart   = criterionLabel.slice(sepIdx + 3).trim();
  const stat = parsePropStat(statPart);
  if (!stat || !playerName) return [];

  // Build PlayerPropLine[] from range offers or single outcomes
  const subOffers = offer.rangeBetOffers?.length ? offer.rangeBetOffers : [offer];
  const props: PlayerPropLine[] = [];

  for (const sub of subOffers) {
    const subOutcomes = sub.outcomes ?? [];
    let overOdds = 0, underOdds = 0, line: number | null = null;
    for (const o of subOutcomes) {
      const odds = kOdds(o.odds);
      if (odds < 1.01) continue;
      const t = String(o.type ?? "").toUpperCase();
      const lm = (o.label ?? "").match(/(\d+[.,]\d+|\d+)/);
      if (lm && line === null) line = parseFloat(lm[1].replace(",", "."));
      if (t === "OT_OVER"  || /over|\+|más\s*de/i.test(o.label ?? ""))  overOdds  = Math.max(overOdds, odds);
      if (t === "OT_UNDER" || /under|-|menos\s*de/i.test(o.label ?? "")) underOdds = Math.max(underOdds, odds);
    }
    if (line !== null && overOdds >= 1.01 && underOdds >= 1.01) {
      props.push({ player: playerName, stat, line, over: overOdds, under: underOdds });
    }
  }

  if (!props.length) return [];
  return [{ bookmaker, sport, eventKey, eventName, league, startTime, isLive, market: "player_props", outcomes: props }];
}

// ─── Main response parser ─────────────────────────────────────────────────────

function parseKambiResponse(
  data: unknown,
  bookmaker: string,
  sport: Sport,
  isLive: boolean,
): ScrapedEvent[] {
  const items: KambiItem[] = (data as any)?.events ?? [];
  if (!Array.isArray(items) || items.length === 0) return [];

  const results: ScrapedEvent[] = [];

  for (const item of items) {
    const ev = item.event;
    if (!ev) continue;

    const state = String(ev.state ?? "").toUpperCase();
    if (isLive  && state !== "STARTED")     continue;
    if (!isLive && state !== "NOT_STARTED") continue;

    const parts = ev.participants ?? [];
    const home = parts.find(p => p.type === "home")?.name ?? ev.homeName ?? parts[0]?.name ?? "";
    const away = parts.find(p => p.type === "away")?.name ?? ev.awayName ?? parts[1]?.name ?? "";
    const eventName = ev.englishName ?? ev.name ?? (home && away ? `${home} - ${away}` : "");
    if (!eventName) continue;

    const startTime = ev.start ? new Date(ev.start) : undefined;
    const eventKey  = buildEventKey(sport, eventName, startTime);

    // Collect all bet offers: mainBetOffer + betOffers + item.rangeBetOffers
    const allOffers: KambiBetOffer[] = [];
    if (item.mainBetOffer) allOffers.push(item.mainBetOffer);
    if (item.betOffers)    allOffers.push(...item.betOffers);
    if (item.rangeBetOffers) allOffers.push(...item.rangeBetOffers);

    for (const offer of allOffers) {
      const market = classifyBetOffer(offer);
      if (!market) continue;

      let parsed: ScrapedEvent[];
      if (market === "player_props") {
        parsed = parsePlayerPropOffer(offer, bookmaker, sport, eventKey, eventName, undefined, startTime, isLive);
      } else {
        parsed = parseBetOffer(offer, market, bookmaker, sport, eventKey, eventName, undefined, startTime, isLive, home, away);
      }
      results.push(...parsed);
    }
  }

  return results;
}

// ─── Scraper class ────────────────────────────────────────────────────────────

export class KambiScraper extends BaseScraper {
  readonly name: string;
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "AMERICANFOOTBALL", "ICEHOCKEY", "BASEBALL"];
  private readonly clientId: string;

  constructor(bookmaker: string, clientId: string) {
    super();
    this.name = bookmaker;
    this.clientId = clientId;

    const proxyUrl = config.scraperProxies.kambi;
    if (proxyUrl) {
      this.http = createProxiedAxios(proxyUrl, 25_000, {
        Referer: `https://www.${bookmaker}.es/`,
      });
    }
  }

  private buildUrl(sport: Sport, isLive: boolean): string {
    const sp = SPORT_PATH[sport];
    if (!sp) return "";
    const base = `${KAMBI_CDN}/offering/v2/${this.clientId}/listView/${sp}/${sp}/all/all`;
    const params = new URLSearchParams({
      lang: "es",
      market: "ES",
      includeParticipants: "true",
      rangeBetOffers: "true",   // include secondary O/U / AH range offers
      numberOfMarkets: "15",    // secondary markets per event
    });
    if (!isLive) params.set("numberOfEvents", "200");
    const suffix = isLive ? "/in-play.json" : ".json";
    return `${base}${suffix}?${params}`;
  }

  private async scrapeForSport(sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    const url = this.buildUrl(sport, isLive);
    if (!url) return [];
    try {
      const { data } = await this.http.get(url);
      const events = parseKambiResponse(data, this.name, sport, isLive);
      this.log(`${isLive ? "live" : "prematch"} ${sport}: ${events.length} events (${
        [...new Set(events.map(e => e.market))].join(",")
      })`);
      return events;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 402 || status === 403) {
        this.warn(`${sport} ${isLive ? "live" : "prematch"}: HTTP ${status} — bloqueado (necesita proxy ES)`);
      } else {
        this.warn(`${sport} ${isLive ? "live" : "prematch"} falló`, err);
      }
      return [];
    }
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    if (!config.scraperProxies.kambi) { this.log("Sin KAMBI_PROXY_URL — necesita proxy ES"); return []; }
    const settled = await Promise.allSettled(this.sports.map(s => this.scrapeForSport(s, true)));
    return settled.flatMap(r => r.status === "fulfilled" ? r.value : []);
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (!config.scraperProxies.kambi) { this.log("Sin KAMBI_PROXY_URL — necesita proxy ES"); return []; }
    const settled = await Promise.allSettled(this.sports.map(s => this.scrapeForSport(s, false)));
    return settled.flatMap(r => r.status === "fulfilled" ? r.value : []);
  }
}
