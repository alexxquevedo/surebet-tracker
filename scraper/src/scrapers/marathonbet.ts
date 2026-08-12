/**
 * Marathonbet España — Playwright scraper.
 *
 * marathonbet.es redirected to their casino section, so we use the
 * international site (marathonbet.com) which has the sportsbook.
 * The site is server-rendered HTML so Cheerio would work, but Playwright
 * avoids the Cloudflare / redirect issues that killed the HTTP approach.
 *
 * CSS selectors: Marathonbet uses a classic table-based layout.
 *   - Event rows:  .coupon-row, tr.event-cell
 *   - Event name:  .member-name, .market-name
 *   - Odds cells:  .price-val, [data-price]
 *
 * If 0 events: check logPageState output — we may be on a blocked page.
 * Try the alternative URL in SPORT_PATHS_ALT below from DevTools.
 */

import { BaseScraper } from "./base";
import { browserManager, dismissCookies, parseOdds, logPageState } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

const BASE = "https://www.marathonbet.com";

const SPORT_PATHS: Record<Sport, { live: string; prematch: string }> = {
  FOOTBALL: {
    live: `${BASE}/su/live/Football/`,
    prematch: `${BASE}/su/popular/Football`,
  },
  TENNIS: {
    live: `${BASE}/su/live/Tennis/`,
    prematch: `${BASE}/su/popular/Tennis`,
  },
  BASKETBALL: {
    live: `${BASE}/su/live/Basketball/`,
    prematch: `${BASE}/su/popular/Basketball`,
  },
};

export class MarathonbetScraper extends BaseScraper {
  readonly name = "marathonbet";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  private async scrapePage(url: string, sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    const { page, ctx } = await browserManager.newPage();
    const events: ScrapedEvent[] = [];
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 50_000 });
      await dismissCookies(page);
      // Marathonbet is server-rendered — short wait for any JS enhancements
      await page.waitForTimeout(2_000);

      // Try to find event rows — Marathonbet uses a classic table layout
      const rows = await page.$$(
        ".coupon-row, .event-cell, tr.event-row, [class*='event-tr'], .member-row"
      );

      for (const row of rows) {
        // Team names
        const nameEl = await row.$(
          ".member-name, .market-name, .event-name, [class*='member-name']"
        );
        const rawName = (await nameEl?.innerText() ?? "").trim().replace(/\n+/g, " vs ");
        if (!rawName || (!rawName.includes(" - ") && !rawName.includes(" vs ") && !rawName.includes(" v "))) continue;

        const eventKey = buildEventKey(sport, rawName);

        // Odds — Marathonbet puts price in data-price attribute or text
        const oddsEls = await row.$$(
          "[data-price], .price-val, .coeff-val, .odds-val, [class*='price']"
        );
        const outcomes: H2HOutcome[] = [];
        const labels = ["1", "X", "2"];

        for (let i = 0; i < Math.min(oddsEls.length, 3); i++) {
          const raw = (await oddsEls[i].getAttribute("data-price")) ?? (await oddsEls[i].innerText());
          const odds = parseOdds(raw ?? "");
          if (odds) outcomes.push({ name: labels[i], odds });
        }

        if (outcomes.length >= 2) {
          events.push({ bookmaker: "marathonbet", sport, eventKey, eventName: rawName, isLive, market: "h2h", outcomes });
        }
      }

      if (events.length === 0) {
        await logPageState(page, this.name);
      } else {
        this.log(`${isLive ? "Live" : "Prematch"} ${sport}: ${events.length} events`);
      }
    } catch (err) {
      this.warn(`${sport} failed`, err);
    } finally {
      await ctx.close();
    }
    return events;
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      all.push(...await this.scrapePage(SPORT_PATHS[sport].live, sport, true));
    }
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      all.push(...await this.scrapePage(SPORT_PATHS[sport].prematch, sport, false));
    }
    return all;
  }
}
