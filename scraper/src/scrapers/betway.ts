/**
 * Betway España — REST API scraper (no Playwright needed).
 *
 * Flow (live):
 *   1. POST GetFavouriteCategoriesTopGroupsInplayEventTables → event IDs by category
 *   2. POST getEventsWithMultipleMarkets with IncludeSelections:true → Events + Markets + Outcomes
 *   3. Parse: for active, non-suspended outcomes map col position to "1"/"X"/"2"
 *
 * Auth params are app-level constants (not user credentials):
 *   BrandId:3, LanguageId:11, TerritoryId:200, TerritoryCode:"ES",
 *   ClientTypeId:2, JurisdictionId:5, ClientIntegratorId:1
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

const execFileAsync = promisify(execFile);

const BASE = "https://betway.es";

const AUTH_FIELDS = {
  BrandId: 3,
  LanguageId: 11,
  TerritoryId: 200,
  TerritoryCode: "ES",
  ClientTypeId: 2,
  JurisdictionId: 5,
  ClientIntegratorId: 1,
};

const CAT_TO_SPORT: Record<string, Sport> = {
  "soccer":            "FOOTBALL",
  "tennis":            "TENNIS",
  "basketball":        "BASKETBALL",
  "baseball":          "BASEBALL",
  "american-football": "AMERICANFOOTBALL",
  "ice-hockey":        "ICEHOCKEY",
};

// H2H market CName per category
const CAT_MARKET: Record<string, string> = {
  "soccer":            "win-draw-win",
  "tennis":            "match-winner",
  "basketball":        "money-line",
  "baseball":          "money-line",
  "american-football": "money-line",
  "ice-hockey":        "money-line",
};

function getProxy(): string {
  return process.env.ROUTER_PROXY_URL ?? "";
}

async function apiPost(path: string, body: object, proxy: string): Promise<any> {
  const payload = { ...AUTH_FIELDS, CorrelationId: randomUUID(), ...body };
  const socksAddr = proxy.replace(/^socks5h?:\/\//, "");
  const { stdout } = await execFileAsync("curl", [
    "-s", "--max-time", "15",
    "--socks5-hostname", socksAddr,
    "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "-H", "Accept: application/json",
    "-H", "Content-Type: application/json",
    "-H", "Accept-Language: es-ES,es;q=0.9",
    "-H", "Origin: https://betway.es",
    "-H", "Referer: https://betway.es/es/es/sports",
    "-X", "POST",
    "-d", JSON.stringify(payload),
    `${BASE}${path}`,
  ], { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export class BetwayScraper extends BaseScraper {
  readonly name    = "betway";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "BASEBALL", "ICEHOCKEY", "AMERICANFOOTBALL"];

  async scrapeLive(): Promise<ScrapedEvent[]> {
    const proxy = getProxy();
    if (!proxy) {
      this.log("Sin ROUTER_PROXY_URL — necesita proxy ES");
      return [];
    }

    try {
      const favData = await apiPost(
        "/es/services/api/events/v2/GetFavouriteCategoriesTopGroupsInplayEventTables",
        { PremiumOnly: false, NumberOfCategories: 20, NumberOfFavourites: 100, NumberOfEventTables: 50, SportsOrderingAreaTypeId: 3 },
        proxy,
      );

      const cats: Array<{ CategoryCName: string; Events: number[] }> = favData?.Categories ?? [];
      const byCategory = new Map<string, number[]>();
      for (const cat of cats) {
        if (CAT_TO_SPORT[cat.CategoryCName] && cat.Events.length > 0) {
          byCategory.set(cat.CategoryCName, cat.Events);
        }
      }

      if (byCategory.size === 0) {
        this.log("Betway live: sin eventos en directo");
        return [];
      }

      const sets = Array.from(byCategory.entries()).map(([catName, eventIds]) => ({
        EventIds: eventIds,
        IncludeAllMarkets: false,
        IncludeSelections: true,
        MarketCNames: [CAT_MARKET[catName]],
      }));

      const data = await apiPost(
        "/es/api/sports/content/getEventsWithMultipleMarkets",
        { EventMarketSets: sets },
        proxy,
      );

      const results = this.parseResponse(data);
      if (results.length > 0) this.log(`Betway live: ${results.length} eventos`);
      else this.warn("Betway live: 0 eventos con cuotas activas");
      return results;
    } catch (err) {
      this.warn("Betway live failed", err);
      return [];
    }
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    return [];
  }

  private parseResponse(data: any): ScrapedEvent[] {
    const eventsArr: any[] = data?.Events ?? [];
    const marketsArr: any[] = data?.Markets ?? [];
    const outcomesArr: any[] = data?.Outcomes ?? [];

    if (eventsArr.length === 0) return [];

    const events = new Map<number, any>(eventsArr.map((e: any) => [e.Id, e]));
    const outcomes = new Map<number, any>(outcomesArr.map((o: any) => [o.Id, o]));

    const eventMarkets = new Map<number, any[]>();
    for (const mkt of marketsArr) {
      const eid: number = mkt.EventId;
      if (!eventMarkets.has(eid)) eventMarkets.set(eid, []);
      eventMarkets.get(eid)!.push(mkt);
    }

    const results: ScrapedEvent[] = [];

    for (const [evId, ev] of events) {
      if (!ev.IsLive || ev.IsSuspended) continue;

      const cat: string = ev.CategoryCName ?? "";
      const sport = CAT_TO_SPORT[cat];
      if (!sport) continue;

      const home: string = ev.HomeTeamName ?? "";
      const away: string = ev.AwayTeamName ?? "";
      if (!home || !away) continue;

      const league: string = ev.GroupName ?? ev.SubCategoryName ?? "";
      const eventName = `${home} v ${away}`;
      const eventKey = buildEventKey(sport, eventName, undefined);

      for (const mkt of eventMarkets.get(evId) ?? []) {
        if (mkt.IsSuspended) continue;

        // Outcomes field is array-of-rows, each row is array of outcome IDs
        const rows: number[][] = mkt.Outcomes ?? [];
        if (rows.length === 0) continue;

        const row = rows[0];
        const is3way = row.length >= 3;

        const h2h: H2HOutcome[] = [];
        for (let colIdx = 0; colIdx < row.length; colIdx++) {
          const o = outcomes.get(row[colIdx]);
          if (!o || !o.IsDisplay || !o.IsActive) continue;
          const odds: number = o.OddsDecimal;
          if (!odds || odds <= 1) continue;

          const name = is3way
            ? (colIdx === 0 ? "1" : colIdx === 1 ? "X" : "2")
            : (colIdx === 0 ? "1" : "2");

          h2h.push({ name, odds });
        }

        if (h2h.length < 2) continue;

        results.push({
          bookmaker: "betway",
          sport,
          eventKey,
          eventName,
          league: league || undefined,
          isLive: true,
          market: "h2h",
          outcomes: h2h,
        });
        break; // one H2H market per event
      }
    }

    return results;
  }
}
