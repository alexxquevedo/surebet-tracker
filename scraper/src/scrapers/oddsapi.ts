import axios from "axios";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";

// ─── Sport mapping ────────────────────────────────────────────────────────────

// Each entry is a distinct league/category key used by The Odds API.
// Prefix determines Sport mapping: soccer_* → FOOTBALL, tennis_* → TENNIS, basketball_* → BASKETBALL.
const TARGET_SPORTS: { key: string; sport: Sport }[] = [
  { key: "soccer_spain_la_liga",         sport: "FOOTBALL" },
  { key: "soccer_spain_segunda_division", sport: "FOOTBALL" },
  { key: "soccer_epl",                   sport: "FOOTBALL" },
  { key: "soccer_germany_bundesliga",    sport: "FOOTBALL" },
  { key: "soccer_italy_serie_a",         sport: "FOOTBALL" },
  { key: "soccer_france_ligue_one",      sport: "FOOTBALL" },
  { key: "soccer_uefa_champs_league",    sport: "FOOTBALL" },
  { key: "soccer_uefa_europa_league",    sport: "FOOTBALL" },
  { key: "tennis_atp",                   sport: "TENNIS"   },
  { key: "tennis_wta",                   sport: "TENNIS"   },
  { key: "basketball_nba",               sport: "BASKETBALL" },
  { key: "basketball_euroleague",        sport: "BASKETBALL" },
];

// ─── Bookmaker key mapping ────────────────────────────────────────────────────

// Maps The Odds API bookmaker key → our internal bookmaker name (used in ScrapedEvent.bookmaker).
// Must stay in sync with BOOKMAKERS in config.ts.
const BOOKMAKER_KEY_MAP: Record<string, string> = {
  bet365:        "bet365",
  betsson:       "betsson",
  bwin:          "bwin",
  williamhill:   "williamhill",
  betfair_ex_eu: "betfair",
  unibet_eu:     "unibet",
  betway:        "betway",
  interwetten:   "interwetten",
  betano:        "betano",
};

const TARGET_BOOKMAKERS = Object.keys(BOOKMAKER_KEY_MAP).join(",");
const BASE_URL = "https://api.the-odds-api.com/v4/sports";

// ─── Rate-limit constants ─────────────────────────────────────────────────────
// The orchestrator polls at 30s (live) and 5min (prematch).
// We enforce a minimum interval inside the scraper to avoid exceeding API quota.
// Default: refresh live data every 90s, prematch every 10min.
// Override via ODDS_API_LIVE_TTL_SEC / ODDS_API_PREMATCH_TTL_SEC env vars.

const LIVE_TTL_MS = parseInt(process.env.ODDS_API_LIVE_TTL_SEC ?? "90") * 1_000;
const PREMATCH_TTL_MS = parseInt(process.env.ODDS_API_PREMATCH_TTL_SEC ?? "600") * 1_000;

// ─── OddsApiScraper ───────────────────────────────────────────────────────────

export class OddsApiScraper extends BaseScraper {
  readonly name = "oddsapi";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  private readonly apiKey: string;

  // Per-type cache to avoid redundant API calls within the minimum TTL window.
  private liveCache: ScrapedEvent[] = [];
  private liveTimestamp = 0;
  private prematchCache: ScrapedEvent[] = [];
  private prematchTimestamp = 0;

  constructor() {
    super();
    this.apiKey = process.env.ODDS_API_KEY ?? "";
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    if (!this.apiKey) {
      this.warn("ODDS_API_KEY not set — skipping live");
      return [];
    }
    const age = Date.now() - this.liveTimestamp;
    if (age < LIVE_TTL_MS && this.liveCache.length > 0) {
      this.log(`live cache hit (${Math.round(age / 1000)}s old, TTL=${LIVE_TTL_MS / 1000}s)`);
      return this.liveCache;
    }
    const all = await this.fetchAll();
    const now = Date.now();
    this.liveCache = all.filter((e) => e.isLive);
    this.liveTimestamp = now;
    this.log(`live: ${this.liveCache.length} events from ${this.countBookmakers(this.liveCache)} bookmakers`);
    return this.liveCache;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (!this.apiKey) {
      this.warn("ODDS_API_KEY not set — skipping prematch");
      return [];
    }
    const age = Date.now() - this.prematchTimestamp;
    if (age < PREMATCH_TTL_MS && this.prematchCache.length > 0) {
      this.log(`prematch cache hit (${Math.round(age / 1000)}s old, TTL=${PREMATCH_TTL_MS / 1000}s)`);
      return this.prematchCache;
    }
    const all = await this.fetchAll();
    const now = Date.now();
    this.prematchCache = all.filter((e) => !e.isLive);
    this.prematchTimestamp = now;
    this.log(`prematch: ${this.prematchCache.length} events from ${this.countBookmakers(this.prematchCache)} bookmakers`);
    return this.prematchCache;
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private async fetchAll(): Promise<ScrapedEvent[]> {
    // Fetch all target sports concurrently; tolerate individual sport failures.
    const settled = await Promise.allSettled(
      TARGET_SPORTS.map((ts) => this.fetchSport(ts.key, ts.sport)),
    );
    const events: ScrapedEvent[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") events.push(...result.value);
    }
    return events;
  }

  private async fetchSport(sportKey: string, sport: Sport): Promise<ScrapedEvent[]> {
    const events: ScrapedEvent[] = [];
    const nowMs = Date.now();

    try {
      const resp = await axios.get(`${BASE_URL}/${sportKey}/odds`, {
        params: {
          apiKey: this.apiKey,
          regions: "eu",
          markets: "h2h",
          oddsFormat: "decimal",
          bookmakers: TARGET_BOOKMAKERS,
        },
        timeout: 12_000,
      });

      for (const event of resp.data) {
        const startTime = new Date(event.commence_time);
        const isLive = startTime.getTime() < nowMs;
        const eventName = `${event.home_team} vs ${event.away_team}`;
        const eventKey = buildEventKey(sport, eventName, startTime);

        for (const bm of event.bookmakers) {
          const bookmaker = BOOKMAKER_KEY_MAP[bm.key];
          if (!bookmaker) continue;

          for (const market of bm.markets) {
            if (market.key !== "h2h") continue;

            const outcomes: H2HOutcome[] = (market.outcomes as any[]).map((o) => ({
              name: o.name as string,
              odds: o.price as number,
            }));

            if (outcomes.length < 2) continue;

            events.push({
              bookmaker,
              sport,
              eventKey,
              eventName,
              isLive,
              startTime,
              market: "h2h",
              outcomes,
            });
          }
        }
      }
    } catch (err: any) {
      // 404 = no events for this sport right now — not an error
      if (err?.response?.status !== 404) {
        this.warn(`${sportKey}: ${err?.response?.status ?? err?.message}`);
      }
    }

    return events;
  }

  private countBookmakers(events: ScrapedEvent[]): number {
    return new Set(events.map((e) => e.bookmaker)).size;
  }
}
