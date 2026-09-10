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
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine } from "../types";

const SPORT_MAP: Record<number, Sport> = {
  1: "FOOTBALL",
  2: "TENNIS",
  7522: "BASKETBALL",
  7524: "ICEHOCKEY",
  6423: "AMERICANFOOTBALL",
  2593174: "BASEBALL",
};

const SPORT_PAGES = [
  "https://www.pokerstars.es/sports/football/",
  "https://www.pokerstars.es/sports/tennis/",
  "https://www.pokerstars.es/sports/basketball/",
  "https://www.pokerstars.es/sports/ice-hockey/",
  "https://www.pokerstars.es/sports/american-football/",
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
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "ICEHOCKEY", "AMERICANFOOTBALL", "BASEBALL"];

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

  // Classify a PSMarket's marketType into our internal market key.
  // O/U lines are embedded in the marketType string: OVER_UNDER_25 → line=2.5
  private classifyPSMarket(marketType: string): { key: string; line?: number } | null {
    if (marketType === "WIN-DRAW-WIN" || marketType === "MATCH_BETTING" ||
        marketType === "WINNER" || marketType === "MONEYLINE") {
      return { key: "h2h" };
    }
    if (/^BOTH_TEAMS_TO_SCORE|^BTTS/i.test(marketType)) return { key: "btts" };
    if (/^DOUBLE_CHANCE/i.test(marketType)) return { key: "double_chance" };
    if (/^ASIAN_HANDICAP/i.test(marketType)) return { key: "asian_handicap" };
    if (/^MATCH_HANDICAP|^HANDICAP/i.test(marketType)) return { key: "handicap" };
    if (/^HALF_TIME_RESULT|^HALF_TIME_WIN/i.test(marketType)) return { key: "h1_h2h" };

    // O/U markets — line encoded in type name: OVER_UNDER_25 → 2.5, OVER_UNDER_45 → 4.5
    const ouMatch = marketType.match(/^OVER_UNDER_(\d+)$/i)
                 ?? marketType.match(/^TOTAL_GOALS_(\d+)$/i)
                 ?? marketType.match(/^GOALS_OVER_UNDER_(\d+)$/i);
    if (ouMatch) {
      const raw = parseInt(ouMatch[1], 10);
      const line = raw > 20 ? raw / 10 : raw; // "25" → 2.5, "3" → 3
      if (/corner/i.test(marketType)) return { key: "corners", line };
      if (/card|booking/i.test(marketType)) return { key: "cards", line };
      if (/half|first/i.test(marketType)) return { key: "h1_goals", line };
      return { key: "goals", line };
    }

    // Tennis/basketball point/game totals
    if (/^TOTAL_POINTS|^POINTS_OVER_UNDER/i.test(marketType)) {
      const numMatch = marketType.match(/(\d+)$/);
      const line = numMatch ? parseInt(numMatch[1], 10) / (parseInt(numMatch[1], 10) > 20 ? 10 : 1) : 0;
      return { key: "goals", line: line || undefined };
    }
    if (/^TOTAL_GAMES|^GAMES_OVER_UNDER/i.test(marketType)) {
      const numMatch = marketType.match(/(\d+)$/);
      const line = numMatch ? parseInt(numMatch[1], 10) / 10 : 0;
      return { key: "games", line: line || undefined };
    }
    if (/^TOTAL_SETS/i.test(marketType)) {
      const numMatch = marketType.match(/(\d+)$/);
      const line = numMatch ? parseInt(numMatch[1], 10) / 10 : 2.5;
      return { key: "sets", line };
    }

    return null;
  }

  private parsePageData(data: PSPageData, seen: Set<string>): ScrapedEvent[] {
    const events: ScrapedEvent[] = [];
    const { competitions = {}, events: psEvents = {}, markets = {} } = data;

    for (const [, mkt] of Object.entries(markets)) {
      if (mkt.marketStatus !== "OPEN") continue;

      const classified = this.classifyPSMarket(mkt.marketType);
      if (!classified) continue;

      const psEvent0 = psEvents[String(mkt.eventId)];
      if (!psEvent0) continue;
      const sport0: Sport | undefined = SPORT_MAP[psEvent0.eventTypeId];
      if (!sport0) continue;

      // Fix: OVER_UNDER_* and TOTAL_POINTS_* get "goals" from classifyPSMarket, but
      // the correct key depends on sport. Remap before further processing.
      let { key: marketKey, line: ouLine } = classified;
      if (marketKey === "goals") {
        if (sport0 === "TENNIS")            marketKey = ouLine && ouLine <= 5 ? "sets" : "games";
        else if (sport0 === "BASKETBALL")   marketKey = "match_points";
        else if (sport0 === "BASEBALL")     marketKey = "runs";
        else if (sport0 === "AMERICANFOOTBALL") marketKey = "match_points";
        // FOOTBALL and ICEHOCKEY stay as "goals"
      }
      const dedupeKey = `${mkt.eventId}:${mkt.marketType}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const psEvent = psEvent0;
      const sport: Sport = sport0;

      const comp = competitions[String(psEvent.competitionId)];
      const league = comp?.competitionName ?? "";
      const startTime = psEvent.eventStartTime ? new Date(psEvent.eventStartTime) : undefined;
      const isLive = psEvent.isInPlay;

      const activeRunners = [...mkt.runners]
        .filter(r => r.runnerStatus === "ACTIVE")
        .sort((a, b) => a.sortPriority - b.sortPriority);

      if (marketKey === "h2h" || marketKey === "double_chance" || marketKey === "btts" || marketKey === "h1_h2h") {
        const h2hOutcomes: H2HOutcome[] = activeRunners.map(r => {
          const odds = r.winRunnerOdds?.decimalDisplayOdds?.decimalOdds;
          if (!odds || odds < 1.01) return null;
          return { name: r.runnerName, odds };
        }).filter((o): o is H2HOutcome => o !== null);
        if (h2hOutcomes.length < 2) continue;

        const participants = h2hOutcomes.map(o => o.name).filter(n => !/^(draw|empate|x|nul|null|tie)$/i.test(n));
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
          isLive,
          market: marketKey === "h1_h2h" ? "h2h" : marketKey,
          outcomes: h2hOutcomes,
        });

      } else if (marketKey === "handicap") {
        // Handicap outcomes: "Team A (+1)", "Draw", "Team B (-1)"
        const h2hOutcomes: H2HOutcome[] = activeRunners.map(r => {
          const odds = r.winRunnerOdds?.decimalDisplayOdds?.decimalOdds;
          if (!odds || odds < 1.01) return null;
          return { name: r.runnerName, odds };
        }).filter((o): o is H2HOutcome => o !== null);
        if (h2hOutcomes.length < 2) continue;
        const matchName = psEvent.eventName;
        events.push({
          bookmaker: "pokerstars", sport,
          eventKey: buildEventKey(sport, matchName, startTime),
          eventName: psEvent.eventName, league, startTime, isLive,
          market: "handicap", outcomes: h2hOutcomes,
        });

      } else {
        // O/U market (goals, corners, cards, sets, games, etc.)
        if (activeRunners.length < 2) continue;
        let over = 0, under = 0, line = ouLine ?? 0;

        for (const r of activeRunners) {
          const odds = r.winRunnerOdds?.decimalDisplayOdds?.decimalOdds;
          if (!odds || odds < 1.01) continue;
          const rName = r.runnerName.toLowerCase();
          // Extract line from runner name if not already known: "Over 2.5" / "Under 2.5"
          if (!line) {
            const numMatch = rName.match(/(\d+\.?\d*)/);
            if (numMatch) line = parseFloat(numMatch[1]);
          }
          if (/^over|^m[aá]s/i.test(r.runnerName))       over = odds;
          else if (/^under|^menos/i.test(r.runnerName))   under = odds;
          else if (r.sortPriority === 1)                    over = odds;
          else                                               under = odds;
        }

        if (!over || !under || !line) continue;
        const tl: TotalsLine = { line, over, under };
        const matchName = psEvent.eventName;
        events.push({
          bookmaker: "pokerstars", sport,
          eventKey: buildEventKey(sport, matchName, startTime),
          eventName: psEvent.eventName, league, startTime, isLive,
          market: marketKey, outcomes: [tl],
        });
      }
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
