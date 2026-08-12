/**
 * Betfair Exchange API scraper.
 * Uses the official free JSON-RPC API — no web scraping needed.
 * Docs: https://developer.betfair.com/exchange-api/
 *
 * Auth flow:
 *   1. POST /api/login → sessionToken (expires 24h / 12h idle)
 *   2. All subsequent calls: X-Application + X-Authentication headers
 */

import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine } from "../types";
import { BaseScraper } from "./base";

// Betfair event type IDs
const EVENT_TYPE_IDS: Record<Sport, string> = {
  FOOTBALL: "1",
  TENNIS: "2",
  BASKETBALL: "7522",
};

// Betfair market types we care about
const MARKET_TYPES = ["MATCH_ODDS", "OVER_UNDER_25", "OVER_UNDER_35", "OVER_UNDER_45"];

interface BetfairRunner {
  selectionId: number;
  runnerName: string;
  ex?: {
    availableToBack?: Array<{ price: number; size: number }>;
    availableToLay?: Array<{ price: number; size: number }>;
  };
}

interface BetfairMarket {
  marketId: string;
  marketName: string;
  marketType?: string;
  event?: { name: string; openDate?: string };
  eventType?: { name: string };
  competition?: { name: string };
  runners?: BetfairRunner[];
}

export class BetfairScraper extends BaseScraper {
  readonly name = "betfair";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  private sessionToken: string | null = null;
  private sessionExpiry: number = 0;

  private betApi: AxiosInstance;

  constructor() {
    super();
    this.betApi = axios.create({
      baseURL: "https://api.betfair.com/exchange/betting/json-rpc/v1",
      timeout: 15_000,
      headers: {
        "Content-Type": "application/json",
        "X-Application": config.betfair.appKey,
      },
    });
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  private async ensureSession(): Promise<void> {
    if (this.sessionToken && Date.now() < this.sessionExpiry) return;

    this.log("Logging in to Betfair...");
    const res = await axios.post(
      "https://identitysso.betfair.com/api/login",
      new URLSearchParams({
        username: config.betfair.username,
        password: config.betfair.password,
      }),
      {
        headers: {
          "X-Application": config.betfair.appKey,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      },
    );

    const { token, status } = res.data;
    if (status !== "SUCCESS" || !token) {
      throw new Error(`Betfair login failed: ${JSON.stringify(res.data)}`);
    }

    this.sessionToken = token;
    // Token valid for 12 hours of inactivity; refresh after 10h
    this.sessionExpiry = Date.now() + 10 * 60 * 60 * 1000;
    this.log("Betfair session obtained.");
  }

  private async callApi<T>(method: string, params: object): Promise<T> {
    await this.ensureSession();
    const body = [{ jsonrpc: "2.0", method: `SportsAPING/v1.0/${method}`, params, id: 1 }];

    const res = await this.betApi.post("", body, {
      headers: { "X-Authentication": this.sessionToken! },
    });

    const result = res.data[0];
    if (result.error) throw new Error(`Betfair API error: ${JSON.stringify(result.error)}`);
    return result.result as T;
  }

  // ─── Market catalogue ────────────────────────────────────────────────────

  private async getMarkets(
    eventTypeId: string,
    inPlayOnly: boolean,
  ): Promise<BetfairMarket[]> {
    const catalogues = await this.callApi<BetfairMarket[]>("listMarketCatalogue", {
      filter: {
        eventTypeIds: [eventTypeId],
        marketTypeCodes: MARKET_TYPES,
        inPlayOnly,
      },
      marketProjection: ["EVENT", "EVENT_TYPE", "COMPETITION", "MARKET_NAME", "RUNNER_DESCRIPTION"],
      maxResults: 200,
    });

    if (!catalogues.length) return [];

    // Fetch odds for all market IDs at once
    const marketIds = catalogues.map((m) => m.marketId);
    const books = await this.callApi<Array<{ marketId: string; runners: BetfairRunner[] }>>(
      "listMarketBook",
      {
        marketIds,
        priceProjection: {
          priceData: ["EX_BEST_OFFERS"],
          exBestOffersOverrides: { bestPricesDepth: 1 },
        },
      },
    );

    // Merge runners into catalogue
    const booksById = new Map(books.map((b) => [b.marketId, b.runners]));
    return catalogues.map((m) => ({
      ...m,
      runners: booksById.get(m.marketId) ?? [],
    }));
  }

  // ─── Parsing ─────────────────────────────────────────────────────────────

  private parseMarkets(markets: BetfairMarket[], sport: Sport, isLive: boolean): ScrapedEvent[] {
    const events: ScrapedEvent[] = [];

    for (const m of markets) {
      if (!m.event || !m.runners?.length) continue;

      const eventName = m.event.name;
      const startTime = m.event.openDate ? new Date(m.event.openDate) : undefined;
      const eventKey = buildEventKey(sport, eventName, startTime);

      // Market type determines outcomes shape
      if (m.marketName?.includes("Match Odds") || m.marketType === "MATCH_ODDS") {
        const outcomes: H2HOutcome[] = m.runners
          .map((r) => {
            const bestBack = r.ex?.availableToBack?.[0]?.price;
            if (!bestBack) return null;
            return { name: r.runnerName, odds: bestBack };
          })
          .filter(Boolean) as H2HOutcome[];

        if (outcomes.length >= 2) {
          events.push({
            bookmaker: "betfair",
            sport,
            eventKey,
            eventName,
            league: m.competition?.name,
            startTime,
            isLive,
            market: "h2h",
            outcomes,
          });
        }
      } else if (m.marketType?.startsWith("OVER_UNDER")) {
        // e.g. OVER_UNDER_25 → line = 2.5
        const lineStr = m.marketType.replace("OVER_UNDER_", "");
        const line = parseInt(lineStr) / 10;

        const overRunner = m.runners.find((r) => r.runnerName.toLowerCase().includes("over"));
        const underRunner = m.runners.find((r) => r.runnerName.toLowerCase().includes("under"));
        const overOdds = overRunner?.ex?.availableToBack?.[0]?.price;
        const underOdds = underRunner?.ex?.availableToBack?.[0]?.price;

        if (overOdds && underOdds) {
          const existing = events.find(
            (e) => e.eventKey === eventKey && e.market === "totals",
          );
          const newLine: TotalsLine = { line, over: overOdds, under: underOdds };
          if (existing) {
            (existing.outcomes as TotalsLine[]).push(newLine);
          } else {
            events.push({
              bookmaker: "betfair",
              sport,
              eventKey,
              eventName,
              league: m.competition?.name,
              startTime,
              isLive,
              market: "totals",
              outcomes: [newLine],
            });
          }
        }
      }
    }

    return events;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async scrapeLive(): Promise<ScrapedEvent[]> {
    if (!config.betfair.appKey || !config.betfair.username) {
      this.warn("Betfair credentials not configured, skipping.");
      return [];
    }

    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      try {
        const markets = await this.getMarkets(EVENT_TYPE_IDS[sport], true);
        all.push(...this.parseMarkets(markets, sport, true));
      } catch (err) {
        this.warn(`Error scraping live ${sport}`, err);
      }
    }
    this.log(`Live: scraped ${all.length} events`);
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (!config.betfair.appKey || !config.betfair.username) {
      this.warn("Betfair credentials not configured, skipping.");
      return [];
    }

    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      try {
        const markets = await this.getMarkets(EVENT_TYPE_IDS[sport], false);
        all.push(...this.parseMarkets(markets, sport, false));
      } catch (err) {
        this.warn(`Error scraping prematch ${sport}`, err);
      }
    }
    this.log(`Prematch: scraped ${all.length} events`);
    return all;
  }
}
