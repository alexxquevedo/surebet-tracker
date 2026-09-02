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
import { createProxiedAxios } from "./proxy-helper";

// Betfair event type IDs
const EVENT_TYPE_IDS: Partial<Record<Sport, string>> = {
  FOOTBALL: "1",
  TENNIS: "2",
  BASKETBALL: "7522",
};

// Betfair market types we care about
const MARKET_TYPES = ["MATCH_ODDS"];

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
  private loginPromise: Promise<void> | null = null; // mutex for concurrent login calls
  private permanentlyDisabled = false;

  constructor() {
    super();
    // Route through proxy if available (Betfair WAF blocks OVH datacenter IPs)
    const proxyUrl = process.env.ROUTER_PROXY_URL || "";
    const baseConfig = {
      baseURL: "https://api.betfair.com/exchange/betting/json-rpc/v1",
      timeout: 15_000,
      headers: { "Content-Type": "application/json", "X-Application": config.betfair.appKey },
    };
    this.betApi = proxyUrl
      ? (() => { const inst = createProxiedAxios(proxyUrl, 15_000); inst.defaults.baseURL = baseConfig.baseURL; inst.defaults.headers.common["Content-Type"] = "application/json"; inst.defaults.headers.common["X-Application"] = config.betfair.appKey; return inst; })()
      : axios.create(baseConfig);
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  private async ensureSession(): Promise<void> {
    if (this.permanentlyDisabled) throw new Error("Betfair desactivado — cuenta requiere cambio de contraseña.");
    if (this.sessionToken && Date.now() < this.sessionExpiry) return;
    // Mutex: if a login is in progress, wait for it instead of starting a new one
    if (this.loginPromise) { await this.loginPromise; return; }
    this.loginPromise = this._doLogin().finally(() => { this.loginPromise = null; });
    await this.loginPromise;
  }

  private async _doLogin(): Promise<void> {
    this.log("Logging in to Betfair...");
    const proxyUrl = process.env.ROUTER_PROXY_URL || "";
    const loginHeaders = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "X-Application": config.betfair.appKey,
    };
    const loginAxios = proxyUrl
      ? createProxiedAxios(proxyUrl, 15_000, loginHeaders)
      : axios.create({ timeout: 15_000, headers: loginHeaders });

    const params = new URLSearchParams({ username: config.betfair.username, password: config.betfair.password });
    const loginUrls = ["https://identitysso-cert.betfair.es/api/login", "https://identitysso.betfair.es/api/login", "https://identitysso.betfair.com/api/login"];
    let res: any = null;
    let lastErr: any = null;
    for (const url of loginUrls) {
      try { res = await loginAxios.post(url, params.toString()); if (res?.data?.status === "SUCCESS") break; } catch (e) { lastErr = e; }
    }
    if (!res) throw lastErr ?? new Error("All Betfair login endpoints failed");

    const { token, status } = res.data;
    if (status === "FAIL" && res.data?.error === "ACCOUNT_PENDING_PASSWORD_CHANGE") {
      this.permanentlyDisabled = true;
      throw new Error("⚠️  Betfair: CUENTA REQUIERE CAMBIO DE CONTRASEÑA — ve a betfair.com e inicia sesión para cambiarla. Scraper desactivado hasta reinicio.");
    }
    if (status !== "SUCCESS" || !token) {
      throw new Error("Betfair login failed: " + JSON.stringify(res.data).slice(0, 120));
    }
    this.sessionToken = token;
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
    if (this.permanentlyDisabled) { this.warn("Betfair desactivado — cambia la contraseña en betfair.com y reinicia el scanner."); return []; }
    if (!config.betfair.appKey || !config.betfair.username) {
      this.warn("Betfair credentials not configured, skipping.");
      return [];
    }

    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      try {
        const markets = await this.getMarkets(EVENT_TYPE_IDS[sport]!, true);
        all.push(...this.parseMarkets(markets, sport, true));
      } catch (err) {
        this.warn(`Error scraping live ${sport}`, err);
      }
    }
    this.log(`Live: scraped ${all.length} events`);
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (this.permanentlyDisabled) { this.warn("Betfair desactivado — cambia la contraseña en betfair.com y reinicia el scanner."); return []; }
    if (!config.betfair.appKey || !config.betfair.username) {
      this.warn("Betfair credentials not configured, skipping.");
      return [];
    }

    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      try {
        const markets = await this.getMarkets(EVENT_TYPE_IDS[sport]!, false);
        all.push(...this.parseMarkets(markets, sport, false));
      } catch (err) {
        this.warn(`Error scraping prematch ${sport}`, err);
      }
    }
    this.log(`Prematch: scraped ${all.length} events`);
    return all;
  }
}
