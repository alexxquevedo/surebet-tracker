/**
 * PokerStars Sports España — REST API + SSR fallback scraper.
 *
 * Strategy:
 * 1. Fetch sports homepage to establish a session (get cookies).
 * 2. Call browse-in-play REST endpoint with session cookies → all live+upcoming
 *    events, ONE main market each.
 * 3. For each event call event-page/{id} → all markets (concurrency-limited).
 * 4. Fall back to SSR widget HTML parsing if the API calls fail (403).
 */

import * as https from "https";
import { execFile } from "child_process";
import { promisify } from "util";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SocksProxyAgent } = require("socks-proxy-agent") as { SocksProxyAgent: new (url: string) => import("https").Agent };
const execFileAsync = promisify(execFile);
import { BaseScraper } from "./base";
import { getProxyForScraper, browserManager } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine, PlayerPropLine } from "../types";

// eventTypeId from browse-in-play / SSR widget
const SPORT_MAP: Record<number, Sport> = {
  1:    "FOOTBALL",
  2:    "TENNIS",
  7522: "BASKETBALL",
  7511: "BASEBALL",
  7524: "ICEHOCKEY",
  6423: "AMERICANFOOTBALL",
};

const PS_SPORT_SLUGS: Partial<Record<Sport, string>> = {
  FOOTBALL:         "football",
  TENNIS:           "tennis",
  BASKETBALL:       "basketball",
  ICEHOCKEY:        "ice-hockey",
  AMERICANFOOTBALL: "american-football",
  BASEBALL:         "baseball",
};

const SPORTS_HOME_URL  = "https://www.pokerstars.es/sports/";
const BROWSE_INPLAY_URL = "https://www.pokerstars.es/sports/web/browse-in-play/";
const EVENT_PAGE_URL   = "https://www.pokerstars.es/sports/web/event-page/";

// Sport-specific prematch pages still used as SSR fallback
const SPORT_PAGES = [
  "https://www.pokerstars.es/sports/football/",
  "https://www.pokerstars.es/sports/tennis/",
  "https://www.pokerstars.es/sports/basketball/",
  "https://www.pokerstars.es/sports/ice-hockey/",
  "https://www.pokerstars.es/sports/american-football/",
  "https://www.pokerstars.es/sports/baseball/",
];

const CACHE_TTL_MS = 600_000; // 10 min — Playwright needed, reduce frequency
const EVENT_PAGE_CONCURRENCY = 8;

// ─── PS data types ───────────────────────────────────────────────────────────

interface PSRunner {
  runnerName: string;
  runnerStatus: string;
  sortPriority: number;
  resultType?: string;
  winRunnerOdds?: { decimalDisplayOdds?: { decimalOdds?: number } };
}

interface PSMarket {
  eventId: number;
  inPlay: boolean;
  marketType: string;
  marketStatus: string;
  marketName?: string;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mergeCookies(existing: string, newer: string): string {
  if (!newer) return existing;
  if (!existing) return newer;
  const parsed = new Map<string, string>();
  for (const c of existing.split(";")) {
    const eq = c.indexOf("=");
    const k = eq >= 0 ? c.slice(0, eq).trim() : c.trim();
    const v = eq >= 0 ? c.slice(eq + 1).trim() : "";
    if (k) parsed.set(k, v);
  }
  for (const c of newer.split(";")) {
    const eq = c.indexOf("=");
    const k = eq >= 0 ? c.slice(0, eq).trim() : c.trim();
    const v = eq >= 0 ? c.slice(eq + 1).trim() : "";
    if (k) parsed.set(k, v);
  }
  return [...parsed.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function pLimit<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// Use curl instead of Node.js https.get for PS REST API endpoints:
// WAF blocks Node.js TLS fingerprint (same pattern as Akamai on Kirolbet).
async function fetchJsonCurl(url: string, cookie: string, proxyUrl: string): Promise<unknown> {
  const socksAddr = proxyUrl.replace(/^socks5h?:\/\//, "");
  const args: string[] = [
    "-s",
    "--max-time", "20",
    "--socks5-hostname", socksAddr,
    "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "-H", "Accept: application/json, text/plain, */*",
    "-H", "Accept-Language: es-ES,es;q=0.9",
    "-H", `Referer: ${SPORTS_HOME_URL}`,
    "-H", "X-Requested-With: XMLHttpRequest",
  ];
  if (cookie) args.push("-H", `Cookie: ${cookie}`);
  args.push(url);
  try {
    const { stdout } = await execFileAsync("curl", args, { maxBuffer: 30 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch { return null; }
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

export class PokerStarsScraper extends BaseScraper {
  readonly name = "pokerstars";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "ICEHOCKEY", "AMERICANFOOTBALL", "BASEBALL"];

  private cachedData: { ts: number; events: ScrapedEvent[] } | null = null;
  private _fetchInFlight: Promise<ScrapedEvent[]> | null = null;

  async scrapeLive(): Promise<ScrapedEvent[]> {
    return (await this.fetchAllEvents()).filter(e => e.isLive);
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    return (await this.fetchAllEvents()).filter(e => !e.isLive);
  }

  // ── Caching coordinator ─────────────────────────────────────────────────

  private async fetchAllEvents(): Promise<ScrapedEvent[]> {
    const now = Date.now();
    if (this.cachedData && now - this.cachedData.ts < CACHE_TTL_MS) return this.cachedData.events;
    if (this._fetchInFlight) return this._fetchInFlight;
    this._fetchInFlight = this._doFetch();
    try { return await this._fetchInFlight; } finally { this._fetchInFlight = null; }
  }

  // ── HTTP primitives ──────────────────────────────────────────────────────

  private async fetchPageWithCookies(
    url: string,
    proxyUrl: string,
    cookie = "",
    redirectsLeft = 4,
  ): Promise<{ body: string | null; cookies: string }> {
    const agent = new SocksProxyAgent(proxyUrl);
    return new Promise((resolve) => {
      const hdrs: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9",
        "Accept-Encoding": "identity",
      };
      if (cookie) hdrs["Cookie"] = cookie;
      const req = https.get(url, { agent, headers: hdrs, timeout: 25_000 }, (res) => {
        const setCookies = (res.headers["set-cookie"] ?? []).map(c => c.split(";")[0]).join("; ");
        const merged = mergeCookies(cookie, setCookies);
        const status = res.statusCode ?? 0;
        if (status >= 301 && status <= 308 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          this.fetchPageWithCookies(next, proxyUrl, merged, redirectsLeft - 1)
            .then(r => resolve({ ...r, cookies: mergeCookies(merged, r.cookies) }));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8"), cookies: merged }));
        res.on("error", () => resolve({ body: null, cookies: merged }));
      });
      req.on("error", () => resolve({ body: null, cookies: "" }));
      req.on("timeout", () => { req.destroy(); resolve({ body: null, cookies: "" }); });
    });
  }

  /** Fetch a JSON API endpoint with session cookies. Returns null on error or 4xx. */
  private async fetchJson(url: string, cookie: string, proxyUrl: string): Promise<unknown> {
    const agent = new SocksProxyAgent(proxyUrl);
    return new Promise((resolve) => {
      const hdrs: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "es-ES,es;q=0.9",
        "Accept-Encoding": "identity",
        "Referer": SPORTS_HOME_URL,
      };
      if (cookie) hdrs["Cookie"] = cookie;
      const req = https.get(url, { agent, headers: hdrs, timeout: 15_000 }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 400) { res.resume(); resolve(null); return; }
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { resolve(null); }
        });
        res.on("error", () => resolve(null));
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
  }

  // ── SSR widget fallback ─────────────────────────────────────────────────

  private extractWidget(html: string): PSPageData | null {
    const WIDGET_KEY = "'isp-sports-widget-home-page'";
    const idx = html.indexOf(WIDGET_KEY);
    if (idx < 0) return null;
    const assignIdx = html.indexOf("|| {}, {", idx);
    if (assignIdx < 0) return null;
    const jsonStart = assignIdx + "|| {}, ".length;
    let depth = 0, end = jsonStart;
    while (end < html.length) {
      const ch = html[end];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end++; break; } }
      else if (ch === '"') {
        end++;
        while (end < html.length && html[end] !== '"') { if (html[end] === "\\") end++; end++; }
      }
      end++;
    }
    try {
      return JSON.parse(
        html.slice(jsonStart, end)
          .replace(/:\s*undefined\b/g, ":null")
          .replace(/:\s*NaN\b/g, ":null")
          .replace(/:\s*Infinity\b/g, ":null")
      ) as PSPageData;
    } catch { return null; }
  }

  // ── Market classification ────────────────────────────────────────────────

  private resolvePSPropStat(mt: string): string | null {
    if (/POINTS_REBOUNDS_ASSISTS|PRA\b/i.test(mt))         return "PRA";
    if (/DOUBLE_DOUBLE/i.test(mt))                          return "DOUBLE_DOUBLE";
    if (/TRIPLE_DOUBLE/i.test(mt))                          return "TRIPLE_DOUBLE";
    if (/THREE_POINT|THREES?\b|3_POINT/i.test(mt))          return "3PT";
    if (/REBOUNDS?/i.test(mt))                              return "REB";
    if (/ASSISTS?/i.test(mt))                               return "AST";
    if (/STEALS?/i.test(mt))                                return "STL";
    if (/BLOCKS?/i.test(mt))                                return "BLK";
    if (/TURNOVERS?/i.test(mt))                             return "TOV";
    if (/GOALS?\b/i.test(mt))                               return "goals";
    if (/SHOTS?\b/i.test(mt))                               return "shots";
    if (/PASSES?\b/i.test(mt))                              return "passes";
    if (/CARDS?\b/i.test(mt))                               return "player_cards";
    if (/ACES?\b/i.test(mt))                                return "aces";
    if (/DOUBLE_FAULT/i.test(mt))                           return "double_faults";
    if (/HOME_RUN/i.test(mt))                               return "HR";
    if (/STRIKEOUT/i.test(mt))                              return "K";
    if (/\bHITS?\b/i.test(mt))                              return "H";
    if (/PASSING_YARD/i.test(mt))                           return "pass_yds";
    if (/RUSHING_YARD/i.test(mt))                           return "rush_yds";
    if (/RECEIVING_YARD|RECEPTION_YARD/i.test(mt))          return "rec_yds";
    if (/PASSING_COMPLETION|COMPLETIONS?/i.test(mt))        return "pass_completions";
    if (/PASS(?:ING)?_ATTEMPT/i.test(mt))                   return "pass_attempts";
    if (/INTERCEPTION/i.test(mt))                           return "pass_int";
    if (/FIELD_GOAL/i.test(mt))                             return "FG";
    if (/FIRST_DOWN/i.test(mt))                             return "first_downs";
    if (/RUSH(?:ING)?_ATTEMPT|CARRIES?\b|CARRY\b/i.test(mt)) return "rush_att";
    if (/\bSACK\b/i.test(mt))                               return "sacks";
    if (/\bTACKLE\b/i.test(mt))                             return "tackles";
    if (/TOUCHDOWN/i.test(mt))                              return "TD";
    if (/RECEPTION/i.test(mt))                              return "REC";
    if (/SHOTS_ON_GOAL|SAVES?\b/i.test(mt))                 return "sog";
    if (/POINTS?/i.test(mt))                                return "PTS";
    return null;
  }

  private classifyPSMarket(marketType: string): { key: string; line?: number } | null {
    if (marketType === "WIN-DRAW-WIN" || marketType === "MATCH_BETTING" ||
        marketType === "WINNER" || marketType === "MONEYLINE" ||
        marketType === "MONEY_LINE") {
      return { key: "h2h" };
    }
    if (/^BOTH_TEAMS_TO_SCORE|^BTTS/i.test(marketType))    return { key: "btts" };
    if (/^DOUBLE_CHANCE/i.test(marketType))                 return { key: "double_chance" };
    if (/^ASIAN_HANDICAP/i.test(marketType))                return { key: "asian_handicap" };
    if (/^(?:MATCH_)?HANDICAP|^HANDICAP/i.test(marketType)) return { key: "handicap" };
    if (/^HALF_TIME_RESULT|^HALF_TIME_WIN/i.test(marketType)) return { key: "h1_h2h" };

    const decodeOULine = (s: string) => { const n = parseInt(s, 10); return n > 20 ? n / 10 : n; };

    const ouMatch = marketType.match(/^OVER_UNDER_(\d+)$/i)
                 ?? marketType.match(/^TOTAL_GOALS_(\d+)$/i)
                 ?? marketType.match(/^GOALS_OVER_UNDER_(\d+)$/i);
    if (ouMatch) {
      const line = decodeOULine(ouMatch[1]);
      if (/corner/i.test(marketType) && !/home_team|away_team/i.test(marketType)) return { key: "corners", line };
      if (/card|booking/i.test(marketType))   return { key: "cards", line };
      if (/half|first/i.test(marketType))     return { key: "h1_goals", line };
      return { key: "goals", line };
    }

    const decodeQLine = (s: string) => { const n = parseInt(s, 10); return n > 20 ? n / 10 : n; };

    const q1m = marketType.match(/^(?:1ST|FIRST)[\s_]QUARTER[\s_\w]*?(\d+)$/i) ?? marketType.match(/^QUARTER[\s_]1[\s_\w]*?(\d+)$/i);
    if (q1m) return { key: "q1_points", line: decodeQLine(q1m[1]) };
    const q2m = marketType.match(/^(?:2ND|SECOND)[\s_]QUARTER[\s_\w]*?(\d+)$/i) ?? marketType.match(/^QUARTER[\s_]2[\s_\w]*?(\d+)$/i);
    if (q2m) return { key: "q2_points", line: decodeQLine(q2m[1]) };
    const q3m = marketType.match(/^(?:3RD|THIRD)[\s_]QUARTER[\s_\w]*?(\d+)$/i) ?? marketType.match(/^QUARTER[\s_]3[\s_\w]*?(\d+)$/i);
    if (q3m) return { key: "q3_points", line: decodeQLine(q3m[1]) };
    const q4m = marketType.match(/^(?:4TH|FOURTH)[\s_]QUARTER[\s_\w]*?(\d+)$/i) ?? marketType.match(/^QUARTER[\s_]4[\s_\w]*?(\d+)$/i);
    if (q4m) return { key: "q4_points", line: decodeQLine(q4m[1]) };

    const h1m = marketType.match(/^(?:1ST|FIRST)[\s_]HALF[\s_\w]*?(\d+)$/i) ?? marketType.match(/^HALF[\s_]TIME[\s_\w]*?(\d+)$/i);
    if (h1m) return { key: "h1_points", line: decodeQLine(h1m[1]) };
    const h2m = marketType.match(/^(?:2ND|SECOND)[\s_]HALF[\s_\w]*?(\d+)$/i);
    if (h2m) return { key: "h2_points", line: decodeQLine(h2m[1]) };

    if (/^(?:SET[\s_]1[\s_]WINNER|FIRST[\s_]SET[\s_]WINNER|SET[\s_]WINNER[\s_]1|1ST[\s_]SET[\s_]WINNER)/i.test(marketType)) return { key: "s1_h2h" };
    if (/^(?:SET[\s_]2[\s_]WINNER|SECOND[\s_]SET[\s_]WINNER|SET[\s_]WINNER[\s_]2|2ND[\s_]SET[\s_]WINNER)/i.test(marketType)) return { key: "s2_h2h" };
    if (/^(?:SET[\s_]3[\s_]WINNER|THIRD[\s_]SET[\s_]WINNER|SET[\s_]WINNER[\s_]3|3RD[\s_]SET[\s_]WINNER)/i.test(marketType)) return { key: "s3_h2h" };
    if (/^(?:TIEBREAK|TIE[\s_]BREAK|WILL[\s_]THERE[\s_]BE[\s_]A[\s_]TIE)/i.test(marketType)) return { key: "tie_break" };

    const sg1 = marketType.match(/^(?:SET[\s_]1|FIRST[\s_]SET)[\s_](?:TOTAL[\s_])?GAMES[\s_](\d+)$/i);
    if (sg1) return { key: "s1_games", line: decodeQLine(sg1[1]) };
    const sg2 = marketType.match(/^(?:SET[\s_]2|SECOND[\s_]SET)[\s_](?:TOTAL[\s_])?GAMES[\s_](\d+)$/i);
    if (sg2) return { key: "s2_games", line: decodeQLine(sg2[1]) };
    const sg3 = marketType.match(/^(?:SET[\s_]3|THIRD[\s_]SET)[\s_](?:TOTAL[\s_])?GAMES[\s_](\d+)$/i);
    if (sg3) return { key: "s3_games", line: decodeQLine(sg3[1]) };

    if (/^TOTAL_POINTS|^POINTS_OVER_UNDER/i.test(marketType)) {
      const n = marketType.match(/(\d+)$/);
      const line = n ? decodeQLine(n[1]) : 0;
      return { key: "goals", line: line || undefined };
    }
    if (/^TOTAL_(?:POINTS_)?(?:\(OVER\/UNDER\)|OVER_UNDER)$/i.test(marketType)) return { key: "goals" };
    if (/^TOTAL_GAMES|^GAMES_OVER_UNDER/i.test(marketType)) {
      const n = marketType.match(/(\d+)$/);
      const line = n ? parseInt(n[1], 10) / 10 : 0;
      return { key: "games", line: line || undefined };
    }
    if (/^TOTAL_SETS/i.test(marketType)) {
      const n = marketType.match(/(\d+)$/);
      return { key: "sets", line: n ? parseInt(n[1], 10) / 10 : 2.5 };
    }

    if (/^PLAYER_/i.test(marketType)) {
      const stat = this.resolvePSPropStat(marketType);
      if (stat) {
        const rawMatch = marketType.match(/(\d+)$/);
        const rawNum = rawMatch ? parseInt(rawMatch[1], 10) : 0;
        return { key: "player_props", line: rawNum > 20 ? rawNum / 10 : rawNum || undefined };
      }
    }

    if (/^(?:FIRST[\s_]FIVE|FIRST[\s_]5|F5)[\s_]INNINGS[\s_](?:BETTING|MONEYLINE|WINNER|RESULT|MATCH_BETTING)/i.test(marketType)) return { key: "h1_h2h" };
    const f5hcap = marketType.match(/^(?:FIRST[\s_]FIVE|FIRST[\s_]5|F5)[\s_]INNINGS[\s_](?:HANDICAP|SPREAD)/i);
    if (f5hcap) return { key: "h1_handicap" };
    const f5runs = marketType.match(/^(?:FIRST[\s_]FIVE|FIRST[\s_]5|F5)[\s_]INNINGS[\s_](?:OVER[\s_]UNDER|TOTAL[\s_]RUNS?)[\s_](\d+)$/i);
    if (f5runs) { const raw = parseInt(f5runs[1], 10); return { key: "h1_runs", line: raw > 20 ? raw / 10 : raw }; }

    // TOTAL_POINTS_(OVER/UNDER) — compact form from browse-in-play
    if (/^TOTAL_POINTS_\(OVER\/UNDER\)/i.test(marketType)) return { key: "goals" };
    // MATCH_HANDICAP_(2-WAY) — handicap without a line encoded in the type
    if (/^MATCH_HANDICAP_\(2-WAY\)/i.test(marketType)) return { key: "handicap" };

    return null;
  }

  // ── Event parsing ────────────────────────────────────────────────────────

  private parsePageData(data: PSPageData, seen: Set<string>): ScrapedEvent[] {
    const events: ScrapedEvent[] = [];
    const { competitions = {}, events: psEvents = {}, markets = {} } = data;

    const matchEventByCompTime = new Map<string, string>();
    for (const [, psEvt] of Object.entries(psEvents)) {
      if (psEvt.eventName.includes(" - ") || / v /i.test(psEvt.eventName) || / vs\.? /i.test(psEvt.eventName)) {
        const key = `${psEvt.competitionId}::${psEvt.eventStartTime}`;
        if (!matchEventByCompTime.has(key)) matchEventByCompTime.set(key, psEvt.eventName);
      }
    }

    for (const [, mkt] of Object.entries(markets)) {
      if (mkt.marketStatus !== "OPEN") continue;
      const classified = this.classifyPSMarket(mkt.marketType);
      if (!classified) continue;

      const psEvent0 = psEvents[String(mkt.eventId)];
      if (!psEvent0) continue;
      const sport0: Sport | undefined = SPORT_MAP[psEvent0.eventTypeId];
      if (!sport0) continue;

      let { key: marketKey, line: ouLine } = classified;

      // Remap "goals" to sport-specific key
      if (marketKey === "goals") {
        if (sport0 === "TENNIS")                marketKey = ouLine && ouLine <= 5 ? "sets" : "games";
        else if (sport0 === "BASKETBALL")       marketKey = "match_points";
        else if (sport0 === "BASEBALL")         marketKey = "runs";
        else if (sport0 === "AMERICANFOOTBALL") marketKey = "match_points";
      }
      if (marketKey === "h1_points" || marketKey === "h2_points") {
        if (sport0 === "FOOTBALL" || sport0 === "ICEHOCKEY")
          marketKey = marketKey === "h1_points" ? "h1_goals" : "h2_goals";
        else if (sport0 !== "BASKETBALL" && sport0 !== "AMERICANFOOTBALL") continue;
      }
      if (["q1_points","q2_points","q3_points","q4_points"].includes(marketKey)) {
        if (sport0 !== "BASKETBALL" && sport0 !== "AMERICANFOOTBALL") continue;
      }
      if (["s1_h2h","s2_h2h","s3_h2h","s1_games","s2_games","s3_games","tie_break"].includes(marketKey)) {
        if (sport0 !== "TENNIS") continue;
      }

      const dedupeKey = `${mkt.eventId}:${mkt.marketType}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const sport = sport0;
      const psEvent = psEvent0;
      const comp = competitions[String(psEvent.competitionId)];
      const league = comp?.competitionName ?? "";
      const startTime = psEvent.eventStartTime ? new Date(psEvent.eventStartTime) : undefined;
      const isLive = psEvent.isInPlay;
      const sportSlug = PS_SPORT_SLUGS[sport];
      const psUrl = sportSlug ? `https://www.pokerstars.es/sports/${sportSlug}/match/${mkt.eventId}/` : undefined;

      const activeRunners = [...mkt.runners]
        .filter(r => r.runnerStatus === "ACTIVE")
        .sort((a, b) => a.sortPriority - b.sortPriority);

      const isH2H = ["h2h","double_chance","btts","h1_h2h","s1_h2h","s2_h2h","s3_h2h","tie_break"].includes(marketKey);

      if (isH2H || marketKey === "handicap") {
        const h2hOutcomes: H2HOutcome[] = activeRunners.map(r => {
          const odds = r.winRunnerOdds?.decimalDisplayOdds?.decimalOdds;
          if (!odds || odds < 1.01) return null;
          return { name: r.runnerName, odds };
        }).filter((o): o is H2HOutcome => o !== null);
        if (h2hOutcomes.length < 2) continue;

        let matchName = psEvent.eventName;
        if (isH2H) {
          const participants = h2hOutcomes.map(o => o.name).filter(n => !/^(draw|empate|x|nul|null|tie)$/i.test(n));
          if (participants.length >= 2) matchName = participants[0] + " - " + participants[participants.length - 1];
        }
        events.push({
          bookmaker: "pokerstars", sport,
          eventKey: buildEventKey(sport, matchName, startTime),
          eventName: psEvent.eventName, league, startTime, isLive,
          market: marketKey, outcomes: h2hOutcomes, url: psUrl,
        });

      } else if (marketKey === "player_props") {
        if (activeRunners.length < 2) continue;
        let over = 0, under = 0, line = ouLine ?? 0;
        for (const r of activeRunners) {
          const odds = r.winRunnerOdds?.decimalDisplayOdds?.decimalOdds;
          if (!odds || odds < 1.01) continue;
          if (!line) { const nm = r.runnerName.match(/(\d+\.?\d*)/); if (nm) line = parseFloat(nm[1]); }
          if (/^over|^m[aá]s/i.test(r.runnerName))      over = odds;
          else if (/^under|^menos/i.test(r.runnerName)) under = odds;
          else if (r.sortPriority === 1)                  over = odds;
          else                                             under = odds;
        }
        if (!over || !under || !line) continue;
        const stat = this.resolvePSPropStat(mkt.marketType);
        if (!stat) continue;
        const playerName = psEvent.eventName;
        const compTimeKey = `${psEvent.competitionId}::${psEvent.eventStartTime}`;
        const matchName = matchEventByCompTime.get(compTimeKey) ?? playerName;
        events.push({
          bookmaker: "pokerstars", sport,
          eventKey: buildEventKey(sport, matchName, startTime),
          eventName: matchName, league, startTime, isLive,
          market: "player_props", outcomes: [{ player: playerName, stat, line, over, under } as PlayerPropLine], url: psUrl,
        });

      } else {
        // O/U market
        if (activeRunners.length < 2) continue;
        let over = 0, under = 0, line = ouLine ?? 0;
        for (const r of activeRunners) {
          const odds = r.winRunnerOdds?.decimalDisplayOdds?.decimalOdds;
          if (!odds || odds < 1.01) continue;
          const rName = r.runnerName.toLowerCase();
          if (!line) { const nm = rName.match(/(\d+\.?\d*)/); if (nm) line = parseFloat(nm[1]); }
          if (/^over|^m[aá]s/i.test(r.runnerName))       over = odds;
          else if (/^under|^menos/i.test(r.runnerName))  under = odds;
          else if (r.sortPriority === 1)                   over = odds;
          else                                              under = odds;
        }
        if (!over || !under || !line) continue;
        events.push({
          bookmaker: "pokerstars", sport,
          eventKey: buildEventKey(sport, psEvent.eventName, startTime),
          eventName: psEvent.eventName, league, startTime, isLive,
          market: marketKey, outcomes: [{ line, over, under } as TotalsLine], url: psUrl,
        });
      }
    }
    return events;
  }

  // ── Playwright: solve Akamai Bot Manager + intercept browse-in-play ───────

  private async _fetchViaPlaywright(
    proxy: { server: string; username?: string; password?: string },
  ): Promise<{ data: PSPageData | null; pwCookies: string }> {
    const { page, ctx } = await browserManager.newPage(proxy, "pokerstars", 120_000);
    try {
      // Approach A: intercept the browse-in-play XHR that fires when PS loads /sports/in-play/.
      // Navigating to the in-play UI page is indistinguishable from a real user; the PS React app
      // calls browse-in-play automatically. Akamai Bot Manager runs on the page before the XHR fires.
      // Direct navigation to the API URL (previous approach) was blocked because the browser
      // sends a page-navigation Accept header and no X-Requested-With, which Akamai flags as a bot.
      let capturedData: PSPageData | null = null;

      const xhrPromise = (page as { waitForResponse(fn: (r: unknown) => boolean, opts: object): Promise<{ json(): Promise<unknown> }> })
        .waitForResponse(
          (r: unknown) => {
            const res = r as { url(): string; status(): number };
            return res.url().includes("/browse-in-play") && res.status() === 200;
          },
          { timeout: 45_000 },
        ).then(async (r) => {
          const raw = await r.json().catch(() => null);
          capturedData = (raw as { data?: PSPageData } | null)?.data ?? null;
        }).catch(() => null);

      await (page as { goto(u: string, o?: object): Promise<unknown> })
        .goto("https://www.pokerstars.es/sports/in-play/", {
          waitUntil: "domcontentloaded",
          timeout: 35_000,
        }).catch(() => null);

      await xhrPromise;

      const ctxCookies = await ctx.cookies(SPORTS_HOME_URL).catch(() => [] as { name: string; value: string }[]);
      const pwCookies = ctxCookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join("; ");

      if (capturedData) {
        this.log("PS Playwright: browse-in-play OK ✓ (in-play page XHR)");
        return { data: capturedData, pwCookies };
      }

      // Approach B: fetch() from within the page's JS context — carries Akamai cookies,
      // correct TLS fingerprint, and looks identical to a same-origin XHR.
      try {
        const evalResult = await (page as { evaluate(fn: (u: string) => Promise<{ status: number; data: unknown }>, u: string): Promise<{ status: number; data: unknown }> })
          .evaluate(async (url: string) => {
            const resp = await fetch(url, {
              headers: {
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "es-ES,es;q=0.9",
                "X-Requested-With": "XMLHttpRequest",
              },
              credentials: "include",
            });
            if (!resp.ok) return { status: resp.status, data: null };
            const data = await resp.json();
            return { status: resp.status, data };
          }, BROWSE_INPLAY_URL);

        if (evalResult.data) {
          this.log("PS Playwright: browse-in-play OK ✓ (page.evaluate fetch)");
          return { data: (evalResult.data as { data?: PSPageData }).data ?? null, pwCookies };
        }
        this.log(`PS Playwright: browse-in-play status=${evalResult.status} (page.evaluate)`);
      } catch (evalErr) {
        this.log(`PS Playwright: page.evaluate error: ${evalErr}`);
      }

      return { data: null, pwCookies };
    } finally {
      await (page as { close(): Promise<void> }).close().catch(() => {});
      await ctx.close().catch(() => {});
    }
  }

  // ── Main fetch ────────────────────────────────────────────────────────────

  private async _doFetch(): Promise<ScrapedEvent[]> {
    const now = Date.now();
    if (this.cachedData && now - this.cachedData.ts < CACHE_TTL_MS) return this.cachedData.events;

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

    const seen = new Set<string>();
    const allEvents: ScrapedEvent[] = [];
    let usedApi = false;

    // ── Phase 1: Establish session + try browse-in-play API ──────────────
    const { body: homeHtml, cookies } = await this.fetchPageWithCookies(SPORTS_HOME_URL, proxyUrl);

    if (cookies) {
      const browseRaw = await fetchJsonCurl(BROWSE_INPLAY_URL, cookies, proxyUrl) as Record<string, unknown> | null;
      const browseData = (browseRaw as { data?: PSPageData } | null)?.data;

      if (browseData?.events) {
        usedApi = true;
        allEvents.push(...this.parsePageData(browseData, seen));

        // ── Phase 2: Event-page for full market coverage ──────────────
        const eventIds = Object.keys(browseData.events);
        const tasks = eventIds.map(eventId => async () => {
          const ep = await fetchJsonCurl(`${EVENT_PAGE_URL}${eventId}`, cookies, proxyUrl) as Record<string, unknown> | null;
          if (!ep?.markets) return;
          this.parsePageData(
            {
              competitions: (ep.competitions as PSPageData["competitions"]) ?? {},
              events:       (ep.events as PSPageData["events"]) ?? {},
              markets:      (ep.markets as PSPageData["markets"]) ?? {},
            },
            seen
          ).forEach(e => allEvents.push(e));
        });
        await pLimit(tasks, EVENT_PAGE_CONCURRENCY);
        this.log(`PS API: ${allEvents.length} markets from ${eventIds.length} events`);
      }
    }

    // ── Phase 3: Playwright — Akamai Bot Manager bypass ──────────────────
    if (!usedApi) {
      this.log("PS curl blocked (Akamai Bot Manager) — intentando Playwright");
      try {
        const { data: pwData, pwCookies } = await this._fetchViaPlaywright(proxy);
        if (pwData?.events) {
          usedApi = true;
          allEvents.push(...this.parsePageData(pwData, seen));
          const eventIds = Object.keys(pwData.events);
          const tasks = eventIds.map(eventId => async () => {
            const ep = await fetchJsonCurl(`${EVENT_PAGE_URL}${eventId}`, pwCookies, proxyUrl) as Record<string, unknown> | null;
            if (!ep?.markets) return;
            this.parsePageData(
              {
                competitions: (ep.competitions as PSPageData["competitions"]) ?? {},
                events:       (ep.events as PSPageData["events"]) ?? {},
                markets:      (ep.markets as PSPageData["markets"]) ?? {},
              },
              seen,
            ).forEach(e => allEvents.push(e));
          });
          await pLimit(tasks, EVENT_PAGE_CONCURRENCY);
          this.log(`PS Playwright+API: ${allEvents.length} markets from ${eventIds.length} events`);
        }
      } catch (err) {
        this.log(`PS Playwright error: ${err}`);
      }
    }

    // ── Phase 4: SSR widget fallback ──────────────────────────────────────
    if (!usedApi) {
      this.log("PS all methods blocked — cayendo en SSR widget");

      if (homeHtml) {
        const data = this.extractWidget(homeHtml);
        if (data) allEvents.push(...this.parsePageData(data, seen));
      }

      // Also fetch individual sport pages
      const htmlResults = await Promise.all(SPORT_PAGES.map(url => this.fetchPage(url, proxyUrl)));
      for (const html of htmlResults) {
        if (!html) continue;
        const data = this.extractWidget(html);
        if (data) allEvents.push(...this.parsePageData(data, seen));
      }
    }

    const live = allEvents.filter(e => e.isLive).length;
    this.log(`PS total: ${allEvents.length} (${live} live, ${allEvents.length - live} prematch)`);
    this.cachedData = { ts: Date.now(), events: allEvents };
    return allEvents;
  }

  // Legacy fetchPage for SSR fallback (no cookie capture needed)
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
        if ((status >= 301 && status <= 308) && res.headers.location && redirectsLeft > 0) {
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
}

