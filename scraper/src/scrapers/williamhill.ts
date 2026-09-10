/**
 * William Hill España — HTML + OpenBet SiteServer REST scraper (no browser/WebSocket).
 *
 * Flow:
 *   1. Fetch sport/live page HTML → extract OB_EV{id} event IDs + sport mapping
 *   2. Batch-call OpenBet SiteServer REST API for all markets per event
 *      GET /siteserver/api/openbet/v1/event/json?obId={id}&includeChildMarkets=Y&marketStatus=A&outcomeStatus=A&lang=es-ES
 *   3. Parse JSON for: H2H, double_chance, handicap, asian_handicap, goals O/U,
 *      h1_goals, btts, corners, yellow_cards, cards
 */

import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine } from "../types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SocksProxyAgent } = require("socks-proxy-agent");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require("axios").default ?? require("axios");

const BASE_URL   = "https://sports.williamhill.es/betting/es-es";
const SS_API     = "https://sports.williamhill.es/siteserver/api/openbet/v1/event/json";
const BATCH_SIZE = 20; // events per SiteServer request

const SPORT_PATHS: Partial<Record<Sport, string>> = {
  FOOTBALL:        "f%C3%BAtbol",
  TENNIS:          "tenis",
  BASKETBALL:      "basketball",
  BASEBALL:        "baseball",
  AMERICANFOOTBALL:"american-football",
  ICEHOCKEY:       "hockey-hielo",
};
const LIVE_PATH = "en-directo/all";

const WH_SPORT_MAP: Record<string, Sport> = {
  OB_SP9:  "FOOTBALL",
  OB_SP24: "TENNIS",
  OB_SP27: "BASKETBALL",
  OB_SP1:  "AMERICANFOOTBALL",
  OB_SP26: "ICEHOCKEY",
  OB_SP2:  "BASEBALL",
};

// OpenBet market type code → internal key
const MKT_TYPE_MAP: Record<string, string> = {
  MR:    "h2h",
  DC:    "double_chance",
  AH:    "asian_handicap",
  MH:    "handicap",
  WH:    "handicap",
  TG:    "goals",
  HHTG:  "h1_goals",
  H2TG:  "h2_goals",
  BTS:   "btts",
  CRN:   "corners",
  ACRN:  "corners",
  BK:    "cards",
  YC:    "yellow_cards",
  RC:    "red_cards",
};

// Fallback: detect by market name when marketType is absent/unknown
const NAME_TO_KEY: Array<[RegExp, string]> = [
  [/resultado\s*final|match\s*result|ganador\s*del\s*partido/i, "h2h"],
  [/doble\s*oportunidad|double\s*chance/i, "double_chance"],
  [/h[aá]ndicap\s+asi[aá]tico|asian\s+handicap/i, "asian_handicap"],
  [/h[aá]ndicap/i, "handicap"],
  [/ambos\s+equipos\s+marcan|both\s+teams\s+to\s+score|btts/i, "btts"],
  [/primera\s+mitad.*goles|goles.*primera\s+mitad|half.?time.*goal|1ª\s+parte.*total/i, "h1_goals"],
  [/tarjeta\s+amarilla|yellow\s+card/i, "yellow_cards"],
  [/tarjeta\s+roja|red\s+card/i, "red_cards"],
  [/tarjeta|card|booking/i, "cards"],
  [/c[oó]rner/i, "corners"],
  [/total\s+goles|goles\s+total|m[aá]s\/menos\s+goles|total\s+goals|over\/under\s+goals/i, "goals"],
  [/total\s+puntos|puntos\s+total|total\s+points/i, "match_points"],
  [/total\s+juegos|total\s+games/i, "games"],
  [/total\s+sets/i, "sets"],
  [/aces|saques\s+directos/i, "aces"],
  [/dobles\s+faltas|double\s+faults/i, "double_faults"],
];

function classifyMarket(marketType: string | undefined, marketName: string): string | null {
  if (marketType) {
    const key = MKT_TYPE_MAP[marketType.toUpperCase()];
    if (key) return key;
  }
  for (const [re, key] of NAME_TO_KEY) {
    if (re.test(marketName)) return key;
  }
  return null;
}

function getProxy(): string {
  return process.env.ROUTER_PROXY_URL || "";
}

// ── HTML extraction ────────────────────────────────────────────────────────────

type PageData = {
  eventIds: string[];
  eventSport: Map<string, Sport>;
};

async function extractPageData(sportUrl: string, proxy: string, defaultSport?: Sport, isLive = false): Promise<PageData> {
  const agent = new SocksProxyAgent(proxy);
  const resp = await axios.get(sportUrl, {
    httpAgent: agent,
    httpsAgent: agent,
    timeout: 20_000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "text/html",
      "Accept-Language": "es-ES,es;q=0.9",
    },
  });
  const html: string = resp.data;

  const boxKey = isLive ? "inPlay" : "preMatch";
  const boxStart = html.indexOf(`modelBox['${boxKey}']`);
  const searchHtml = boxStart >= 0 ? html.slice(boxStart, boxStart + 600_000) : html;

  // Extract all unique OB_EV IDs from topic paths
  const topics = [...new Set<string>(searchHtml.match(/PDS\/OB_EV\d+\/OB_MA\d+\/OB_OU\d+/g) || [])];
  const allEventIds = [...new Set(topics.map(t => t.match(/OB_EV(\d+)/)?.[1] ?? "").filter(Boolean))];

  // Build event → sport map
  const eventSport = new Map<string, Sport>();
  const evSportPat = /"OB_EV(\d+)":\{[^}]{0,400}?"sportId":"(\w+)"/g;
  let m: RegExpExecArray | null;
  while ((m = evSportPat.exec(html)) !== null) {
    const sport = WH_SPORT_MAP[m[2]];
    if (sport) eventSport.set(m[1], sport);
  }

  if (eventSport.size === 0 && allEventIds.length > 0 && defaultSport) {
    for (const id of allEventIds) eventSport.set(id, defaultSport);
  }

  // Only keep event IDs with a known sport
  const eventIds = allEventIds.filter(id => eventSport.has(id));

  return { eventIds, eventSport };
}

// ── OpenBet SiteServer REST ────────────────────────────────────────────────────

function decimalFromPrice(price: any): number | null {
  if (!price) return null;
  // priceDecimal is a string or number
  const dec = parseFloat(String(price.priceDecimal ?? ""));
  if (dec >= 1.01 && dec < 1001) return dec;
  // Fall back to fractional
  const n = parseFloat(String(price.priceNum ?? ""));
  const d = parseFloat(String(price.priceDen ?? ""));
  if (!isNaN(n) && d > 0) {
    const calc = parseFloat((n / d + 1).toFixed(4));
    if (calc >= 1.01 && calc < 1001) return calc;
  }
  return null;
}

function bestPrice(prices: any[]): number | null {
  if (!Array.isArray(prices)) return null;
  // Prefer LP (live price) over SP (starting price)
  const lp = prices.find((p: any) => p.priceType === "LP");
  const result = decimalFromPrice(lp ?? prices[0]);
  return result;
}

function parseSSEvent(
  ssEvent: any,
  eventSport: Map<string, Sport>,
  defaultSport: Sport | undefined,
  isLive: boolean,
): ScrapedEvent[] {
  const evId = String(ssEvent.id ?? "").replace(/^OB_EV/, "").replace(/\D/g, "");
  const sport: Sport | undefined = eventSport.get(evId) ?? defaultSport;
  if (!sport) return [];

  const evName: string = ssEvent.name ?? "";
  const startTime = ssEvent.startTime ? new Date(ssEvent.startTime) : undefined;
  const eventKey = buildEventKey(sport, evName, startTime);
  const evIsLive = isLive || Boolean(ssEvent.isStarted);
  const markets: any[] = (ssEvent.children ?? []).map((c: any) => c.market).filter(Boolean);

  const events: ScrapedEvent[] = [];

  for (const mkt of markets) {
    const mktName: string = mkt.name ?? "";
    const mktType: string = mkt.marketType ?? mkt.nfo?.type ?? "";
    const marketKey = classifyMarket(mktType, mktName);
    if (!marketKey) continue;

    const outcomes: any[] = (mkt.children ?? []).map((c: any) => c.outcome).filter(Boolean);
    if (outcomes.length < 2) continue;

    // Skip suspended / non-active markets
    if (mkt.status && mkt.status !== "A" && mkt.status !== "Active") continue;

    if (marketKey === "h2h" || marketKey === "double_chance" || marketKey === "btts") {
      const h2hOutcomes: H2HOutcome[] = outcomes.map((o: any) => {
        const prices: any[] = o.prices ?? [];
        const odds = bestPrice(prices);
        if (!odds) return null;
        return { name: String(o.name ?? ""), odds };
      }).filter((o): o is H2HOutcome => o !== null);
      if (h2hOutcomes.length < 2) continue;
      events.push({ bookmaker: "williamhill", sport, eventKey, eventName: evName, isLive: evIsLive, startTime, market: marketKey, outcomes: h2hOutcomes });

    } else if (marketKey === "handicap") {
      // European handicap: outcomes named e.g. "Barcelona (+1)", "Empate", "Real Madrid (-1)"
      const lines = new Map<string, H2HOutcome[]>();
      for (const o of outcomes) {
        const odds = bestPrice(o.prices ?? []);
        if (!odds) continue;
        const oName: string = o.name ?? "";
        const lineMatch = oName.match(/([+-]?\d+\.?\d*)\)?$/);
        const lineKey = lineMatch ? lineMatch[1] : "0";
        if (!lines.has(lineKey)) lines.set(lineKey, []);
        lines.get(lineKey)!.push({ name: oName, odds });
      }
      for (const [, h2hOutcomes] of lines) {
        if (h2hOutcomes.length < 2) continue;
        events.push({ bookmaker: "williamhill", sport, eventKey, eventName: evName, isLive: evIsLive, startTime, market: "handicap", outcomes: h2hOutcomes });
      }

    } else if (marketKey === "asian_handicap") {
      // AH outcomes: "Barcelona -0.5", "Real Madrid +0.5" — group by absolute line
      const lines = new Map<string, TotalsLine>();
      for (const o of outcomes) {
        const odds = bestPrice(o.prices ?? []);
        if (!odds) continue;
        const oName: string = o.name ?? "";
        const lineMatch = oName.match(/([+-]?\d+\.?\d*)\s*$/);
        const rawLine = lineMatch ? parseFloat(lineMatch[1]) : parseFloat(String(o.handicapValueDec ?? o.handHcapValueDec ?? "0"));
        const absLine = Math.abs(rawLine);
        const key = String(absLine);
        if (!lines.has(key)) lines.set(key, { line: absLine, over: 0, under: 0 });
        const tl = lines.get(key)!;
        if (rawLine <= 0) tl.over = odds; else tl.under = odds;
      }
      for (const tl of lines.values()) {
        if (!tl.over || !tl.under) continue;
        events.push({ bookmaker: "williamhill", sport, eventKey, eventName: evName, isLive: evIsLive, startTime, market: "asian_handicap", outcomes: [tl] });
      }

    } else {
      // O/U markets: goals, h1_goals, h2_goals, corners, cards, etc.
      // Outcomes: "Más de X.X" / "Menos de X.X" or "Over X.X" / "Under X.X"
      const lines = new Map<string, TotalsLine>();
      for (const o of outcomes) {
        const odds = bestPrice(o.prices ?? []);
        if (!odds) continue;
        const oName: string = (o.name ?? "").toLowerCase();
        // Extract line value from outcome name
        const numMatch = oName.match(/(\d+\.?\d*)/);
        if (!numMatch) continue;
        const line = parseFloat(numMatch[1]);
        const key = String(line);
        if (!lines.has(key)) lines.set(key, { line, over: 0, under: 0 });
        const tl = lines.get(key)!;
        if (/m[aá]s\s*de|over|over\s*de/i.test(o.name)) tl.over = odds;
        else if (/menos\s*de|under/i.test(o.name))        tl.under = odds;
        else if (o.outcomeMeaningMajorCode === "H")        tl.over = odds;
        else if (o.outcomeMeaningMajorCode === "A")        tl.under = odds;
      }
      for (const tl of lines.values()) {
        if (!tl.over || !tl.under) continue;
        events.push({ bookmaker: "williamhill", sport, eventKey, eventName: evName, isLive: evIsLive, startTime, market: marketKey, outcomes: [tl] });
      }
    }
  }

  return events;
}

async function fetchMarketsViaRest(
  eventIds: string[],
  eventSport: Map<string, Sport>,
  defaultSport: Sport | undefined,
  proxy: string,
  isLive: boolean,
): Promise<ScrapedEvent[]> {
  if (eventIds.length === 0) return [];

  const agent = new SocksProxyAgent(proxy);
  const allEvents: ScrapedEvent[] = [];

  for (let i = 0; i < eventIds.length; i += BATCH_SIZE) {
    const batch = eventIds.slice(i, i + BATCH_SIZE);
    const params = new URLSearchParams();
    for (const id of batch) params.append("obId", id);
    params.set("includeChildMarkets", "Y");
    params.set("marketStatus", "A");
    params.set("outcomeStatus", "A");
    params.set("lang", "es-ES");

    try {
      const resp = await axios.get(`${SS_API}?${params.toString()}`, {
        httpAgent: agent,
        httpsAgent: agent,
        timeout: 15_000,
        headers: {
          Accept: "application/json",
          "Accept-Language": "es-ES,es;q=0.9",
          Referer: "https://sports.williamhill.es/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      const ssResp = resp.data?.SSResponse ?? resp.data;
      const children: any[] = ssResp?.children ?? [];
      for (const child of children) {
        const ev = child.event;
        if (!ev) continue;
        const parsed = parseSSEvent(ev, eventSport, defaultSport, isLive);
        allEvents.push(...parsed);
      }
    } catch (err: any) {
      const status = err?.response?.status;
      if (status !== 404) {
        const msg = status ? `HTTP ${status}` : String(err?.message ?? err).slice(0, 80);
        console.warn(`[williamhill] SiteServer batch ${i}–${i + batch.length}: ${msg}`);
      }
    }
  }

  return allEvents;
}

// ── Scraper class ──────────────────────────────────────────────────────────────

export class WilliamHillScraper extends BaseScraper {
  readonly name = "williamhill";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "BASEBALL", "AMERICANFOOTBALL", "ICEHOCKEY"];

  private async scrapePage(
    pageUrl: string,
    defaultSport: Sport | undefined,
    isLive: boolean,
  ): Promise<ScrapedEvent[]> {
    const proxy = getProxy();
    if (!proxy) {
      this.log("Sin ROUTER_PROXY_URL — necesita proxy ES");
      return [];
    }

    try {
      this.log(`WH ${defaultSport ?? "LIVE"} (${isLive ? "live" : "prematch"}): fetching HTML...`);
      const { eventIds, eventSport } = await extractPageData(pageUrl, proxy, defaultSport, isLive);

      if (eventIds.length === 0) {
        this.warn(`WH ${defaultSport ?? "LIVE"}: no event IDs found in HTML`);
        return [];
      }

      this.log(`WH ${defaultSport ?? "LIVE"}: ${eventIds.length} events — calling SiteServer REST...`);
      const events = await fetchMarketsViaRest(eventIds, eventSport, defaultSport, proxy, isLive);

      // Deduplicate by eventKey + market + line
      const seen = new Set<string>();
      const deduped = events.filter(ev => {
        const line = Array.isArray(ev.outcomes) && ev.outcomes.length > 0 && "line" in ev.outcomes[0]
          ? String((ev.outcomes[0] as TotalsLine).line)
          : "";
        const k = `${ev.eventKey}|${ev.market}|${line}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      if (deduped.length > 0) {
        const mktCounts = deduped.reduce((acc, e) => { acc[e.market] = (acc[e.market] ?? 0) + 1; return acc; }, {} as Record<string, number>);
        this.log(`WH ${defaultSport ?? "LIVE"}: ${deduped.length} events (${Object.entries(mktCounts).map(([k, v]) => `${k}:${v}`).join(", ")})`);
      } else {
        this.warn(`WH ${defaultSport ?? "LIVE"}: 0 events from ${eventIds.length} event IDs`);
      }

      return deduped;
    } catch (err) {
      this.warn(`WH ${defaultSport ?? "LIVE"} failed`, err);
      return [];
    }
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    return this.scrapePage(`${BASE_URL}/${LIVE_PATH}`, undefined, true);
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    const results = await Promise.all(
      this.sports
        .filter(sport => SPORT_PATHS[sport])
        .map(sport => this.scrapePage(`${BASE_URL}/${SPORT_PATHS[sport]!}`, sport, false))
    );
    return results.flat();
  }
}
