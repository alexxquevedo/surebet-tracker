/**
 * PokerStars Sports España — Playwright scraper.
 *
 * Approach: Playwright navega a /sports/ con proxy ES.
 * Inyecta un Proxy en window.__INITIAL_STATE__ para capturar el widget
 * 'isp-sports-widget-home-page' del SSR antes de que React hidrate.
 * Ese widget contiene eventos (live y prematch) + markets (WIN-DRAW-WIN / MATCH_BETTING)
 * con odds ya incluidas — sin GraphQL ni markets-updates adicionales.
 */

import { chromium } from "playwright";
import { BaseScraper } from "./base";
import { getProxyForScraper } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

const SPORT_MAP: Record<number, Sport> = {
  1: "FOOTBALL",
  2: "TENNIS",
  7524: "ICEHOCKEY",
  468328: "HANDBALL",
  998917: "VOLLEYBALL",
};

const HOME_URL = "https://www.pokerstars.es/sports/";
// Cache TTL largo: el live navega cada 30s, el prematch cada 120s.
// Ambos comparten el mismo fetch; el prematch usa el cache del live.
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
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "ICEHOCKEY", "HANDBALL"];

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

    // Uses its own browser instance (not the shared semaphore) — lightweight SSR scrape
    const chromiumPath = process.env.CHROMIUM_PATH ?? "/usr/bin/google-chrome";
    const browser = await chromium.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions"],
    });
    const ctx = await browser.newContext({
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "es-ES",
    });
    const page = await ctx.newPage();
    const events: ScrapedEvent[] = [];

    try {
      // Inject before scripts run so we capture SSR __INITIAL_STATE__ assignments
      await page.addInitScript(() => {
        const capturedKeys: Record<string, unknown> = {};
        const handler: ProxyHandler<Record<string, unknown>> = {
          set(target, prop: string, value) {
            capturedKeys[prop] = value;
            target[prop] = value;
            return true;
          },
          get(target, prop: string) {
            return target[prop];
          },
        };
        (window as unknown as Record<string, unknown>).__INITIAL_STATE__ = new Proxy({}, handler);
        (window as unknown as Record<string, unknown>).__CAPTURED_KEYS__ = capturedKeys;
      });

      await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 28_000 });
      await page.waitForTimeout(1_500);

      const homeData = await page.evaluate((): PSHomeData | null => {
        const captured = (window as unknown as Record<string, Record<string, unknown>>).__CAPTURED_KEYS__;
        if (!captured) return null;
        return (captured["isp-sports-widget-home-page"] as PSHomeData) ?? null;
      });

      if (!homeData?.markets) {
        this.warn("No se capturó isp-sports-widget-home-page data");
        return [];
      }

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
        // Use runner names (full player/team names) instead of psEvent.eventName which uses
        // abbreviated names like L Harris - Tsitsipas that fail to match other books.
        const participants = outcomes.map(o => o.name).filter(n => !/^(draw|empate|x|nul|null|unentschieden)$/i.test(n));
        const matchName = participants.length >= 2
          ? participants[0] +  -  + participants[participants.length - 1]
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
    } catch (err) {
      this.warn("fetchAllEvents failed", err);
    } finally {
      await browser.close().catch(() => {});
    }

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
