/**
 * Codere España — NavigationService HTTP scraper (sin navegador).
 *
 * Codere usa su propia API REST en m.apuestas.codere.es/NavigationService.
 * La API es pública y no requiere autenticación ni proxy desde OVH.
 *
 * Live:    GET /Event/GetLiveEventsAndSportsBySportHandle?gametypes=
 *          → { Events: [{ Name, SportHandle, DefaultGame: { Results: [{ Name, Odd, SortOrder }] } }] }
 *
 * Prematch (por liga):
 *  1. GET /LeftMenu/GetCountriesAndHighlights?parentid={sportNodeId}
 *     → { highlights: [{ NodeId, Name }] }
 *  2. GET /Event/GetEvents?parentid={leagueNodeId}
 *     → [{ Name, ParticipantHome, ParticipantAway, Games: [{ Results: [{ Name, Odd }] }] }]
 */

import * as https from "https";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";
import { saveFailedPayload } from "./playwright-base";

const BASE = "https://m.apuestas.codere.es/NavigationService";

// Sport NodeIds — from /NavigationService/LeftMenu/GetMenuLeft (static, verified 2026-07)
const SPORT_NODEIDS: Partial<Record<Sport, string>> = {
  FOOTBALL:   "9553177903",
  TENNIS:     "2819846742",
  BASKETBALL: "2819833466",
};

const SPORT_HANDLES: Partial<Record<Sport, string>> = {
  FOOTBALL:   "soccer",
  TENNIS:     "tennis",
  BASKETBALL: "basketball",
};

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function codereGet(path: string): Promise<any> {
  const url = `${BASE}/${path}`;
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        Accept: "application/json",
        Referer: "https://m.apuestas.codere.es/deportesEs/",
        Origin: "https://m.apuestas.codere.es",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Mobile Safari/537.36",
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(15_000, () => { req.destroy(); resolve(null); });
  });
}

// ─── Date parser ─────────────────────────────────────────────────────────────

function parseCodereDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  // Format: "/Date(1786815000000)/"
  const m = raw.match(/\/Date\((-?\d+)\)\//);
  return m ? new Date(parseInt(m[1])) : undefined;
}

// ─── Odds parser ─────────────────────────────────────────────────────────────

function buildEvent(
  results: any[],
  bookmaker: string,
  sport: Sport,
  eventName: string,
  startTime: Date | undefined,
  isLive: boolean,
): ScrapedEvent | null {
  if (!results || results.length < 2) return null;
  const sorted = [...results].sort((a, b) => (a.SortOrder ?? 0) - (b.SortOrder ?? 0));
  const outcomes: H2HOutcome[] = sorted
    .map((r: any) => {
      const odds = parseFloat(String(r.Odd ?? 0));
      const name: string = r.Name ?? "";
      return odds >= 1.01 && name ? { name, odds } : null;
    })
    .filter(Boolean) as H2HOutcome[];
  if (outcomes.length < 2) return null;
  const eventKey = buildEventKey(sport, eventName, startTime);
  return { bookmaker, sport, eventKey, eventName, startTime, isLive, market: "h2h", outcomes };
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

export class CodereScraper extends BaseScraper {
  readonly name = "codere";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  async scrapeLive(): Promise<ScrapedEvent[]> {
    const data = await codereGet("Event/GetLiveEventsAndSportsBySportHandle?gametypes=");
    if (!data?.Events?.length) {
      this.warn("Live: no data from NavigationService");
      return [];
    }

    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      const handle = SPORT_HANDLES[sport];
      const sportEvents: any[] = data.Events.filter((e: any) => e.SportHandle === handle);
      let found = 0;
      for (const e of sportEvents) {
        const name: string = e.Name ?? `${e.ParticipantHome ?? ""} - ${e.ParticipantAway ?? ""}`.trim();
        const results: any[] = e.DefaultGame?.Results ?? [];
        const startTime = parseCodereDate(e.StartDate);
        const ev = buildEvent(results, "codere", sport, name, startTime, true);
        if (ev) { all.push(ev); found++; }
      }
      if (sportEvents.length) this.log(`Live ${sport}: ${found}/${sportEvents.length} events with odds`);
    }
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    const all: ScrapedEvent[] = [];

    for (const sport of this.sports) {
      const nodeId = SPORT_NODEIDS[sport];

      // 1. Get highlighted leagues for this sport
      const menuData = await codereGet(`LeftMenu/GetCountriesAndHighlights?parentid=${nodeId}`);
      const highlights: any[] = menuData?.highlights ?? [];

      if (!highlights.length) {
        this.warn(`Prematch ${sport}: no highlights from GetCountriesAndHighlights`);
        continue;
      }

      // 2. Fetch events for each highlighted league (top 5 to limit API calls)
      let found = 0;
      const leaguesToFetch = highlights.slice(0, 5);
      for (const league of leaguesToFetch) {
        const leagueNodeId: string = String(league.NodeId ?? "");
        if (!leagueNodeId) continue;
        const events = await codereGet(`Event/GetEvents?parentid=${leagueNodeId}`);
        if (!Array.isArray(events)) continue;

        for (const e of events) {
          const name: string = e.Name ?? `${e.ParticipantHome ?? ""} - ${e.ParticipantAway ?? ""}`.trim();
          if (!name) continue;
          // Prematch events: odds in Games[0].Results (not DefaultGame)
          const games: any[] = e.Games ?? [];
          const results: any[] = games[0]?.Results ?? [];
          const startTime = parseCodereDate(e.StartDate);
          const ev = buildEvent(results, "codere", sport, name, startTime, false);
          if (ev) { all.push(ev); found++; }
        }
      }
      this.log(`Prematch ${sport}: ${found} events from ${leaguesToFetch.length} leagues`);
    }
    return all;
  }
}
