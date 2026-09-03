/**
 * PokerStars Sports España — HTTP scraper (no browser).
 *
 * Approach: HTTP GET a /sports/ con socks5 proxy ES.
 * El SSR embeds __INITIAL_STATE__['isp-sports-widget-home-page'] directamente en el HTML.
 * Extraemos el JSON con regex — sin Playwright, sin Chrome.
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
};

const HOME_URL = "https://www.pokerstars.es/sports/";
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

interface PSHomeData {
  competitions: Record<string, PSCompetition>;
  events: Record<string, PSEvent>;
  markets: Record<string, PSMarket>;
}

export class PokerStarsScraper extends BaseScraper {
  readonly name = "pokerstars";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "ICEHOCKEY", "RUGBYLEAGUE", "AMERICANFOOTBALL", "HANDBALL", "VOLLEYBALL"];

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

    // Build proxy URL with credentials if present
    let proxyUrl = proxy.server;
    if (proxy.username) {
      const u = new URL(proxy.server);
      u.username = encodeURIComponent(proxy.username);
      u.password = encodeURIComponent(proxy.password ?? "");
      proxyUrl = u.toString();
    }

    const agent = new SocksProxyAgent(proxyUrl);
    const html = await new Promise<string>((resolve, reject) => {
      const req = https.get(HOME_URL, {
        agent,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept-Language": "es-ES,es;q=0.9",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "identity",
        },
        timeout: 20_000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("PokerStars HTTP timeout")); });
    });

    // Extract isp-sports-widget-home-page JSON from HTML
    const WIDGET_KEY = "'isp-sports-widget-home-page'";
    const idx = html.indexOf(WIDGET_KEY);
    if (idx < 0) {
      this.warn("isp-sports-widget-home-page no encontrado en el HTML");
      return [];
    }
    // Pattern: Object.assign(window.__INITIAL_STATE__['isp-sports-widget-home-page'] || {}, {JSON})
    const assignIdx = html.indexOf("|| {}, {", idx);
    if (assignIdx < 0) {
      this.warn("Patrón Object.assign no encontrado tras el widget key");
      return [];
    }
    const jsonStart = assignIdx + "|| {}, ".length;
    // Walk braces to find closing }
    let depth = 0;
    let end = jsonStart;
    while (end < html.length) {
      const ch = html[end];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end++; break; } }
      else if (ch === '"') {
        // Skip string content
        end++;
        while (end < html.length && html[end] !== '"') {
          if (html[end] === "\\") end++;
          end++;
        }
      }
      end++;
    }

    let homeData: PSHomeData;
    try {
      // The HTML contains JavaScript object literals, not JSON — replace JS-only values
      const jsonStr = html.slice(jsonStart, end)
        .replace(/:\s*undefined\b/g, ":null")
        .replace(/:\s*NaN\b/g, ":null")
        .replace(/:\s*Infinity\b/g, ":null");
      homeData = JSON.parse(jsonStr) as PSHomeData;
    } catch (e) {
      this.warn("JSON parse error: " + String(e).slice(0, 120));
      return [];
    }

    const events: ScrapedEvent[] = [];
    const { competitions = {}, events: psEvents = {}, markets = {} } = homeData;

    for (const mkt of Object.values(markets)) {
      if (mkt.marketStatus !== "OPEN") continue;
      if (mkt.marketType !== "WIN-DRAW-WIN" && mkt.marketType !== "MATCH_BETTING") continue;

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
      const eventKey = buildEventKey(sport, matchName, startTime);

      events.push({
        bookmaker: "pokerstars",
        sport,
        eventKey,
        eventName: psEvent.eventName,
        league,
        startTime,
        isLive: psEvent.isInPlay,
        market: "h2h",
        outcomes,
      });
    }

    const live = events.filter(e => e.isLive).length;
    this.log(`${events.length} events (${live} live, ${events.length - live} prematch)`);
    this.cachedData = { ts: Date.now(), events };
    return events;
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    return (await this.fetchAllEvents()).filter(e => e.isLive);
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    return (await this.fetchAllEvents()).filter(e => !e.isLive);
  }
}
