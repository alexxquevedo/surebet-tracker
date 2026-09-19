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
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine, PlayerPropLine } from "../types";
import { BaseScraper } from "./base";
import { createProxiedAxios } from "./proxy-helper";

// Betfair event type IDs
const EVENT_TYPE_IDS: Partial<Record<Sport, string>> = {
  FOOTBALL: "1",
  TENNIS: "2",
  BASKETBALL: "7522",
  AMERICANFOOTBALL: "6423",
};

// Betfair market types for H2H
const MARKET_TYPES = ["MATCH_ODDS"];

// Additional market types for tennis/basketball totals
// Betfair reuses TOTAL_GOALS across sports (tennis total games, basketball total points)
const TOTALS_MARKET_TYPES = ["TOTAL_GOALS"];

// Maps sport to the internal totals market key
const SPORT_TOTALS_KEY: Partial<Record<Sport, string>> = {
  TENNIS: "games",
  BASKETBALL: "match_points",
};

// Canonical NFL player prop stat names (matched against Betfair market names)
const NFL_PROP_STATS: Array<[RegExp, string]> = [
  [/\bsacks?\b/i, "sacks"],
  [/\breceiving\s+long(?:est)?\b/i, "rec_yds_long"],
  [/\bpass(?:ing)?\s+yards?\b/i, "pass_yds"],
  [/\brush(?:ing)?\s+yards?\b/i, "rush_yds"],
  [/\breceiv(?:ing)?\s+yards?\b/i, "rec_yds"],
  [/\btouchdowns?\b/i, "TD"],
  [/\breceptions?\b|\bcatches?\b/i, "REC"],
  [/\bcompletions?\b/i, "pass_completions"],
  [/\bfirst\s+downs?\b/i, "first_downs"],
  [/\bfield\s+goals?\b/i, "FG"],
  [/\binterceptions?\b/i, "pass_int"],
];

// Parse a Betfair market (name + runners) into a PlayerPropLine for NFL player props.
// Betfair market name format: "[Full Name] [Stat]" or "[Full Name] - [Total Stat]"
// Runners: "Over 0.5" / "Under 0.5" (back odds only)
function parseNFLPlayerPropMarket(
  marketName: string,
  runners: BetfairRunner[],
): { player: string; stat: string; line: number; over: number; under: number } | null {
  let stat: string | null = null;
  let statMatchIndex = -1;
  for (const [re, s] of NFL_PROP_STATS) {
    const m = marketName.match(re);
    if (m && m.index !== undefined) { stat = s; statMatchIndex = m.index; break; }
  }
  if (!stat || statMatchIndex < 0) return null;

  // Player name = everything before the stat keyword
  const player = marketName
    .slice(0, statMatchIndex)
    .replace(/\s*[-–—]\s*$/, "")
    .replace(/\s+total\s*$/i, "")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  if (player.length < 3) return null;

  // Extract line + odds from runners ("Over 0.5", "Under 0.5")
  let over = 0, under = 0, line = 0;
  for (const r of runners) {
    const rName = (r.runnerName ?? "").toLowerCase();
    const odds = r.ex?.availableToBack?.[0]?.price;
    if (!odds || odds < 1.01) continue;
    const lm = rName.match(/(\d+\.?\d*)/);
    if (!lm) continue;
    const l = parseFloat(lm[1]);
    if (/\bover\b/.test(rName)) { over = odds; line = l; }
    else if (/\bunder\b/.test(rName)) { under = odds; }
  }

  if (!over || !under || !line) return null;
  return { player, stat, line, over, under };
}

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
  // AMERICANFOOTBALL only in prematch (NFL rarely live in European hours)
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  private sessionToken: string | null = null;
  private sessionExpiry: number = 0;

  private betApi: AxiosInstance;
  private loginPromise: Promise<void> | null = null;
  private permanentlyDisabled = false;
  // Slot-based rate limiter: each callApi atomically reserves the next available slot.
  // Prevents DSC-0018 even when live + prematch cycles run concurrently.
  private _nextAllowedCallAt = 0;
  private readonly _callMinGapMs = 500;

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
    // Atomic slot reservation — prevents race condition when live+prematch run concurrently
    const now = Date.now();
    if (now >= this._nextAllowedCallAt) {
      this._nextAllowedCallAt = now + this._callMinGapMs;
    } else {
      const mySlot = this._nextAllowedCallAt;
      this._nextAllowedCallAt += this._callMinGapMs;
      const waitMs = mySlot - Date.now();
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    }

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
    marketTypeCodes?: string[],
  ): Promise<BetfairMarket[]> {
    const filter: Record<string, unknown> = { eventTypeIds: [eventTypeId], inPlayOnly };
    if (marketTypeCodes) filter.marketTypeCodes = marketTypeCodes;

    const catalogues = await this.callApi<BetfairMarket[]>("listMarketCatalogue", {
      filter,
      marketProjection: ["EVENT", "EVENT_TYPE", "COMPETITION", "MARKET_NAME", "RUNNER_DESCRIPTION"],
      maxResults: marketTypeCodes ? 200 : 500,
    });

    if (!catalogues.length) return [];

    // Chunk into ≤200 per listMarketBook call (API limit)
    const all: BetfairMarket[] = [];
    const CHUNK = 200;
    for (let i = 0; i < catalogues.length; i += CHUNK) {
      const chunk = catalogues.slice(i, i + CHUNK);
      const books = await this.callApi<Array<{ marketId: string; runners: Array<{ selectionId: number; ex: BetfairRunner["ex"] }> }>>(
        "listMarketBook",
        {
          marketIds: chunk.map((m) => m.marketId),
          priceProjection: {
            priceData: ["EX_BEST_OFFERS"],
            exBestOffersOverrides: { bestPricesDepth: 1 },
          },
        },
      );
      // Merge by selectionId: catalogue has runnerName, book has ex (odds)
      const exById = new Map(books.map((b) => [b.marketId, new Map(b.runners.map((r) => [r.selectionId, r.ex]))]));
      for (const m of chunk) {
        const exMap = exById.get(m.marketId);
        all.push({
          ...m,
          runners: (m.runners ?? []).map((r) => ({ ...r, ex: exMap?.get(r.selectionId) })),
        });
      }
    }
    return all;
  }

  // ─── Parsing ─────────────────────────────────────────────────────────────

  // Parses TOTAL_GOALS markets for tennis (games) and basketball (match_points)
  private parseTotalsMarkets(markets: BetfairMarket[], sport: Sport, isLive: boolean): ScrapedEvent[] {
    const totalsKey = SPORT_TOTALS_KEY[sport];
    if (!totalsKey) return [];

    const byEvent = new Map<string, ScrapedEvent>();

    for (const m of markets) {
      if (!m.event || !m.runners?.length) continue;

      const eventName = m.event.name;
      const startTime = m.event.openDate ? new Date(m.event.openDate) : undefined;
      const eventKey = buildEventKey(sport, eventName, startTime);

      // Group Over/Under runners by line value
      const lineMap = new Map<number, { over: number; under: number }>();
      for (const r of m.runners) {
        const rName = (r.runnerName ?? "").toLowerCase();
        const odds = r.ex?.availableToBack?.[0]?.price;
        if (!odds || odds < 1.01) continue;
        const lm = rName.match(/(\d+\.?\d*)/);
        if (!lm) continue;
        const line = parseFloat(lm[1]);
        if (!lineMap.has(line)) lineMap.set(line, { over: 0, under: 0 });
        const entry = lineMap.get(line)!;
        if (/\bover\b/i.test(rName)) entry.over = odds;
        else if (/\bunder\b/i.test(rName)) entry.under = odds;
      }

      const lines: TotalsLine[] = [];
      for (const [line, { over, under }] of lineMap) {
        if (over && under) lines.push({ line, over, under });
      }
      if (!lines.length) continue;

      const existing = byEvent.get(eventKey);
      if (existing) {
        (existing.outcomes as TotalsLine[]).push(...lines);
      } else {
        byEvent.set(eventKey, {
          bookmaker: "betfair",
          sport,
          eventKey,
          eventName,
          league: m.competition?.name,
          startTime,
          isLive,
          market: totalsKey,
          outcomes: lines,
        });
      }
    }

    return [...byEvent.values()];
  }

  private parseMarkets(markets: BetfairMarket[], sport: Sport, isLive: boolean): ScrapedEvent[] {
    const events: ScrapedEvent[] = [];

    for (const m of markets) {
      if (!m.event || !m.runners?.length) continue;

      const eventName = m.event.name;
      const startTime = m.event.openDate ? new Date(m.event.openDate) : undefined;
      const eventKey = buildEventKey(sport, eventName, startTime);

      if (m.marketName?.includes("Match Odds") || m.marketType === "MATCH_ODDS") {
        // ── H2H ──
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
      } else if (sport === "AMERICANFOOTBALL") {
        // ── NFL player props ──
        const prop = parseNFLPlayerPropMarket(m.marketName, m.runners);
        if (!prop) continue;

        const propLine: PlayerPropLine = { player: prop.player, stat: prop.stat, line: prop.line, over: prop.over, under: prop.under };
        const existing = events.find((e) => e.eventKey === eventKey && e.market === "player_props");
        if (existing) {
          (existing.outcomes as PlayerPropLine[]).push(propLine);
        } else {
          events.push({
            bookmaker: "betfair",
            sport,
            eventKey,
            eventName,
            league: m.competition?.name,
            startTime,
            isLive,
            market: "player_props",
            outcomes: [propLine],
          });
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
      const id = EVENT_TYPE_IDS[sport];
      if (!id) continue;
      try {
        const markets = await this.getMarkets(id, true, MARKET_TYPES);
        all.push(...this.parseMarkets(markets, sport, true));
      } catch (err) {
        this.warn(`Error scraping live ${sport}`, err);
      }
      // Fetch totals (O/U) markets for tennis and basketball
      if (sport === "TENNIS" || sport === "BASKETBALL") {
        try {
          const totalsMarkets = await this.getMarkets(id, true, TOTALS_MARKET_TYPES);
          all.push(...this.parseTotalsMarkets(totalsMarkets, sport, true));
        } catch (err) {
          this.warn(`Error scraping live totals for ${sport}`, err);
        }
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

    // H2H for all sports
    for (const sport of this.sports) {
      const id = EVENT_TYPE_IDS[sport];
      if (!id) continue;
      try {
        const markets = await this.getMarkets(id, false, MARKET_TYPES);
        all.push(...this.parseMarkets(markets, sport, false));
      } catch (err) {
        this.warn(`Error scraping prematch ${sport}`, err);
      }
      // Fetch totals (O/U) markets for tennis and basketball
      if (sport === "TENNIS" || sport === "BASKETBALL") {
        try {
          const totalsMarkets = await this.getMarkets(id, false, TOTALS_MARKET_TYPES);
          all.push(...this.parseTotalsMarkets(totalsMarkets, sport, false));
        } catch (err) {
          this.warn(`Error scraping prematch totals for ${sport}`, err);
        }
      }
    }

    // NFL player props: fetch all market types (no filter) then parse non-MATCH_ODDS
    try {
      const nflId = EVENT_TYPE_IDS.AMERICANFOOTBALL!;
      const allNfl = await this.getMarkets(nflId, false);
      const propOnly = allNfl.filter((m) => m.marketType !== "MATCH_ODDS" && !m.marketName?.includes("Match Odds"));
      all.push(...this.parseMarkets(propOnly, "AMERICANFOOTBALL", false));
    } catch (err) {
      this.warn("Error scraping NFL player props", err);
    }

    this.log(`Prematch: scraped ${all.length} events`);
    return all;
  }
}
