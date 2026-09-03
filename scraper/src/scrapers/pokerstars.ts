/**
 * PokerStars Sports España — HTTP scraper (no browser).
 *
 * Fetches per-sport pages in parallel. Each sport page embeds the full
 * isp-sports-widget-home-page SSR JSON filtered to that sport.
 * Events are deduplicated by eventId+marketType across pages.
 */

import * as https from "https";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SocksProxyAgent } = require("socks-proxy-agent") as { SocksProxyAgent: new (url: string) => import("https").Agent };
import { BaseScraper } from "./base";
import { getProxyForScraper } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

const SPORT_MAP: Record<number, Sport> = {
  1: "FOOTBALL",
  2: "TENNIS",
  7522: "BASKETBALL",
  7524: "ICEHOCKEY",
  1477: "RUGBYLEAGUE",
  6423: "AMERICANFOOTBALL",
  468328: "HANDBALL",
  998917: "VOLLEYBALL",
  2593174: "BASEBALL",
};

const SPORT_PAGES = [
  "https://www.pokerstars.es/sports/football/",
  "https://www.pokerstars.es/sports/tennis/",
  "https://www.pokerstars.es/sports/basketball/",
  "https://www.pokerstars.es/sports/ice-hockey/",
  "https://www.pokerstars.es/sports/handball/",
  "https://www.pokerstars.es/sports/volleyball/",
  "https://www.pokerstars.es/sports/american-football/",
  "https://www.pokerstars.es/sports/rugby-league/",
  "https://www.pokerstars.es/sports/baseball/",
];

const CACHE_TTL_MS = 110_000;

interface PSRunner {
  runnerName: string;
  runnerStatus: string;
  sortPriority: number;
  winRunnerOdds?: { decimalDisplayOdds?: { decimalOdds?: number } };
}

interface PSMarket {
  eventId: number;
  inPlay: boolean;
  marketType: string;
  marketStatus: string;
  runners: PSRunner[];
}

interface PSEvent {
  eventId: number;
  eventName: string;
  eventStartTime: string;
  isInPlay: boolean;
  eventTypeId: number;
  competitionId: number;
}

interface PSCompetition {
  competitionId: number;
  competitionName: string;
}

interface PSPageData {
  competitions: Record<string, PSCompetition>;
  events: Record<string, PSEvent>;
  markets: Record<string, PSMarket>;
}

export class PokerStarsScraper extends BaseScraper {
  readonly name = "pokerstars";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "ICEHOCKEY", "RUGBYLEAGUE", "AMERICANFOOTBALL", "HANDBALL", "VOLLEYBALL", "BASEBALL"];

  private cachedData: { ts: number; events: ScrapedEvent[] } | null = null;
  private _fetchInFlight: Promise<ScrapedEvent[]> | null = null;

  private async fetchAllEvents(): Promise<ScrapedEvent[]> {
    const now = Date.now();
    if (this.cachedData && now - this.cachedData.ts < CACHE_TTL_MS) {
      return this.cachedData.events;
    }
    if (this._fetchInFlight) return this._fetchInFlight;
    this._fetchInFlight = this._doFetch();
    try { return await this._fetchInFlight; } finally { this._fetchInFlight = null; }
  }

  private async fetchPage(url: string, proxyUrl: string, redirectsLeft = 3): Promise<string | null> {
    const agent = new SocksProxyAgent(proxyUrl);
    return new Promise<string | null>((resolve) => {
      const req = https.get(url, {
        agent,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept-Language": "es-ES,es;q=0.9",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "identity",
        },
        timeout: 25_000,
      }, (res) => {
        const status = res.statusCode ?? 0;
        if ((status === 301 || status === 302 || status === 307 || status === 308) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, url).toString();
          this.fetchPage(next, proxyUrl, redirectsLeft - 1).then(resolve);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", () => resolve(null));
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
  }

  private extractWidget(html: string): PSPageData | null {
    const WIDGET_KEY = "'isp-sports-widget-home-page'";
    const idx = html.indexOf(WIDGET_KEY);
    if (idx < 0) return null;

    const assignIdx = html.indexOf("|| {}, {", idx);
    if (assignIdx < 0) return null;

    const jsonStart = assignIdx + "|| {}, ".length;
    let depth = 0;
    let end = jsonStart;
    while (end < html.length) {
      const ch = html[end];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end++; break; } }
      else if (ch === '"') {
        end++;
        while (end < html.length && html[end] !== '"') {
          if (html[end] === "\\") end++;
          end++;
        }
      }
      end++;
    }

    try {
      const jsonStr = html.slice(jsonStart, end)
        .replace(/:\s*undefined\b/g, ":null")
        .replace(/:\s*NaN\b/g, ":null")
        .replace(/:\s*Infinity\b/g, ":null");
      return JSON.parse(jsonStr) as PSPageData;
    } catch {
      return null;
    }
  }

  private parsePageData(data: PSPageData, seen: Set<string>): ScrapedEvent[] {
    const events: ScrapedEvent[] = [];
    const { competitions = {}, events: psEvents = {}, markets = {} } = data;

    for (const [mktId, mkt] of Object.entries(markets)) {
      if (mkt.marketStatus !== "OPEN") continue;
      if (mkt.marketType !== "WIN-DRAW-WIN" && mkt.marketType !== "MATCH_BETTING") continue;

      const dedupeKey = `${mkt.eventId}:${mkt.marketType}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const psEvent = psEvents[String(mkt.eventId)];
      if (!psEvent) continue;

      const sport: Sport | undefined = SPORT_MAP[psEvent.eventTypeId];
      if (!sport) continue;

      const comp = competitions[String(psEvent.competitionId)];
      const league = comp?.competitionName ?? "";

      const outcomes: H2HOutcome[] = [...mkt.runners]
        .filter(r => r.runnerStatus === "ACTIVE")
        .sort((a, b) => a.sortPriority - b.sortPriority)
        .map(r => {
          const odds = r.winRunnerOdds?.decimalDisplayOdds?.decimalOdds;
          if (!odds || odds < 1.01) return null;
          return { name: r.runnerName, odds };
        })
        .filter((o): o is H2HOutcome => o !== null);

      if (outcomes.length < 2) continue;

      const startTime = psEvent.eventStartTime ? new Date(psEvent.eventStartTime) : undefined;
      const participants = outcomes.map(o => o.name).filter(n => !/^(draw|empate|x|nul|null|unentschieden)$/i.test(n));
      const matchName = participants.length >= 2
        ? participants[0] + " - " + participants[participants.length - 1]
        : psEvent.eventName;

      events.push({
        bookmaker: "pokerstars",
        sport,
        eventKey: buildEventKey(sport, matchName, startTime),
        eventName: psEvent.eventName,
        league,
        startTime,
        isLive: psEvent.isInPlay,
        market: "h2h",
        outcomes,
      });
    }
    return events;
  }

  private async _doFetch(): Promise<ScrapedEvent[]> {
    const now = Date.now();
    if (this.cachedData && now - this.cachedData.ts < CACHE_TTL_MS) {
      return this.cachedData.events;
    }

    const proxy = getProxyForScraper("pokerstars");
    if (!proxy) {
      this.log("Sin proxy ES — necesita ROUTER_PROXY_URL o POKERSTARS_PROXY_URL");
      return [];
    }

    let proxyUrl = proxy.server;
    if (proxy.username) {
      const u = new URL(proxy.server);
      u.username = encodeURIComponent(proxy.username);
      u.password = encodeURIComponent(proxy.password ?? "");
      proxyUrl = u.toString();
    }

    // Fetch all sport pages in parallel — each gets its own agent instance
    const htmlResults = await Promise.all(SPORT_PAGES.map(url => this.fetchPage(url, proxyUrl)));

    const seen = new Set<string>();
    const allEvents: ScrapedEvent[] = [];
    let pagesOk = 0;

    for (let i = 0; i < SPORT_PAGES.length; i++) {
      const html = htmlResults[i];
      if (!html) continue;

      const data = this.extractWidget(html);
      if (!data) continue;

      pagesOk++;
      const pageEvents = this.parsePageData(data, seen);
      allEvents.push(...pageEvents);
    }

    const live = allEvents.filter(e => e.isLive).length;
    this.log(`${allEvents.length} events (${live} live, ${allEvents.length - live} prematch) from ${pagesOk}/${SPORT_PAGES.length} pages`);
    this.cachedData = { ts: Date.now(), events: allEvents };
    return allEvents;
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    return (await this.fetchAllEvents()).filter(e => e.isLive);
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    return (await this.fetchAllEvents()).filter(e => !e.isLive);
  }
}
