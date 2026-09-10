/**
 * 888sport España — Spectate platform Playwright scraper.
 *
 * 888sport migrated from Kambi to their own "Spectate" platform.
 * The inplay API at spectate-web.888sport.es requires session cookies
 * that are set by the SPA during initial page load — direct HTTP calls
 * return empty bodies. Playwright navigates the live page and intercepts
 * the API response.
 *
 * Flow (live):
 *   1. Navigate to https://www.888sport.es/apuestas-en-vivo/
 *   2. Intercept response from spectate-web.888sport.es/.../getInplayEvents/all
 *   3. Parse selections object — each event_id key maps to array of selection rows
 *      with selection_type ("1"/"X"/"2"), decimal_current_price, sport_slug, etc.
 *   4. Filter: suspended=false, is_market_suspended=false, visible=1
 */

import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import { browserManager, getProxyForScraper } from "./playwright-base";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

const LIVE_URL = "https://www.888sport.es/apuestas-en-vivo/";
const INPLAY_URL_FRAGMENT = "getInplayEvents/all";

const SLUG_TO_SPORT: Record<string, Sport> = {
  "football":         "FOOTBALL",
  "tennis":           "TENNIS",
  "basketball":       "BASKETBALL",
  "american-football":"AMERICANFOOTBALL",
  "ice-hockey":       "ICEHOCKEY",
  "baseball":         "BASEBALL",
};

export class Sport888Scraper extends BaseScraper {
  readonly name    = "888sport";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "AMERICANFOOTBALL", "ICEHOCKEY", "BASEBALL"];

  async scrapeLive(): Promise<ScrapedEvent[]> {
    const proxyHint = getProxyForScraper("sport888");
    if (!proxyHint) {
      this.log("Sin proxy configurado para 888sport");
      return [];
    }

    const { page, ctx } = await browserManager.newPage(proxyHint, "888sport", 30_000);

    return new Promise<ScrapedEvent[]>((resolve) => {
      let settled = false;
      let captured: any | null = null;

      const closeAndResolve = async (result: ScrapedEvent[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        await ctx.close().catch(() => {});
        resolve(result);
      };

      // Hard 35s timeout — spectate fires getInplayEvents/all ~10-18s after page load
      const hardTimeout = setTimeout(() => {
        if (captured) {
          const results = parseSpectateResponse(captured);
          this.log(`888sport Playwright hard timeout — ${results.length} eventos`);
          void closeAndResolve(results);
        } else {
          this.warn("888sport Playwright hard timeout — sin respuesta getInplayEvents/all");
          void closeAndResolve([]);
        }
      }, 35_000);

      (async () => {
        try {
          page.setDefaultNavigationTimeout(12_000);

          page.on("response", async (res: any) => {
            if (res.status() !== 200) return;
            const url: string = res.url();
            if (!url.includes(INPLAY_URL_FRAGMENT)) return;
            try {
              const data = await Promise.race([
                res.json(),
                new Promise<null>(r => setTimeout(r, 3_000, null)),
              ]);
              if (data && typeof data.selections === "object") {
                captured = data;
                // Got the data — resolve immediately without waiting for the full timeout
                const results = parseSpectateResponse(data);
                this.log(`888sport: ${results.length} eventos (${Object.keys(data.selections).length} event IDs)`);
                void closeAndResolve(results);
              }
            } catch { /* ok */ }
          });

          await page.goto(LIVE_URL, { waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => {});
          // Wait for lazy spectate API calls — fires 10-18s after domcontentloaded
          await page.waitForTimeout(20_000);

          // If still no data after waiting, close with whatever we have
          const results = captured ? parseSpectateResponse(captured) : [];
          if (!captured) this.warn("888sport: getInplayEvents/all no recibido en 20s");
          await closeAndResolve(results);
        } catch (err) {
          this.warn("888sport Playwright error", err);
          await closeAndResolve([]);
        }
      })();
    });
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    return [];
  }
}

function parseSpectateResponse(data: any): ScrapedEvent[] {
  const selections: Record<string, any[]> = data.selections ?? {};
  const results: ScrapedEvent[] = [];

  for (const [, sels] of Object.entries(selections)) {
    if (!Array.isArray(sels) || sels.length === 0) continue;

    // All selections for one event share the same event metadata
    const first = sels[0];
    const sportSlug: string = first.sport_slug ?? "";
    const sport = SLUG_TO_SPORT[sportSlug];
    if (!sport) continue;

    const home: string = first.home_team_name ?? "";
    const away: string = first.away_team_name ?? "";
    if (!home || !away) continue;

    const league: string = first.category_slug ?? "";
    const eventName = `${home} v ${away}`;
    const eventKey = buildEventKey(sport, eventName, undefined);

    const h2h: H2HOutcome[] = [];
    for (const sel of sels) {
      if (sel.suspended || sel.is_market_suspended) continue;
      if (!sel.visible || !sel.tradable) continue;

      const selType: string = sel.selection_type; // "1" | "X" | "2"
      if (!selType) continue;

      const odds = parseFloat(String(sel.decimal_current_price));
      if (isNaN(odds) || odds <= 1) continue;

      h2h.push({ name: selType, odds });
    }

    if (h2h.length < 2) continue;

    results.push({
      bookmaker: "888sport",
      sport,
      eventKey,
      eventName,
      league: league || undefined,
      isLive: true,
      market: "h2h",
      outcomes: h2h,
    });
  }

  return results;
}
