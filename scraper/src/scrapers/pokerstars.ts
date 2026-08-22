/**
 * PokerStars Sports España — Playwright scraper.
 *
 * PokerStars Sports usa la plataforma Kambi (mismo que Sportium y Betsson).
 * Interceptamos las llamadas XHR a la CDN de Kambi.
 *
 * Kambi response: { liveEvents/events: [{ event: { name, homeName, awayName }, betOffers: [...] }] }
 * Odds: milli-odds (dividir entre 1000 para obtener decimal).
 */

import { BaseScraper } from "./base";
import { browserManager, dismissCookies, logPageState, getProxyForScraper } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

const URLS: Partial<Record<Sport, { live: string; prematch: string }>> = {
  FOOTBALL: {
    live:     "https://www.pokerstarssports.es/sports/football/live",
    prematch: "https://www.pokerstarssports.es/sports/football",
  },
  TENNIS: {
    live:     "https://www.pokerstarssports.es/sports/tennis/live",
    prematch: "https://www.pokerstarssports.es/sports/tennis",
  },
  BASKETBALL: {
    live:     "https://www.pokerstarssports.es/sports/basketball/live",
    prematch: "https://www.pokerstarssports.es/sports/basketball",
  },
};

// ─── Kambi parser (comparte lógica con Sportium) ─────────────────────────────

const toDecimal = (raw: any): number => {
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  return n > 100 ? n / 1000 : n;
};

function parseKambi(data: any, sport: Sport, isLive: boolean): ScrapedEvent[] {
  const eventList: any[] =
    data?.liveEvents ??
    data?.events ??
    data?.offeringEvents?.events ??
    data?.betOfferCategories?.flatMap((c: any) => c.events ?? []) ??
    [];
  if (!eventList.length) return [];

  const events: ScrapedEvent[] = [];
  for (const item of eventList) {
    const ev = item.event ?? item;
    const eventName: string =
      ev.name ??
      (ev.homeName && ev.awayName ? `${ev.homeName} - ${ev.awayName}` : "");
    if (!eventName) continue;

    const startTime = ev.start ? new Date(ev.start) : undefined;
    const eventKey = buildEventKey(sport, eventName, startTime);
    const league: string = ev.group ?? ev.path?.[1]?.name ?? "";

    for (const offer of (item.betOffers ?? [])) {
      const label: string = (
        offer.criterion?.label ??
        offer.betOfferType?.name ??
        ""
      ).toLowerCase();
      const isH2H =
        label.includes("1x2") ||
        label.includes("full time") ||
        label.includes("resultado") ||
        label.includes("match result") ||
        label.includes("winner") ||
        label.includes("ganador");
      if (!isH2H) continue;

      const outcomes: H2HOutcome[] = (offer.outcomes ?? [])
        .map((o: any) => {
          const odds = toDecimal(o.odds ?? o.decimalOdds ?? 0);
          const name: string = o.label ?? o.type ?? "";
          return odds >= 1.01 && name ? { name, odds } : null;
        })
        .filter(Boolean) as H2HOutcome[];

      if (outcomes.length >= 2) {
        events.push({
          bookmaker: "pokerstars",
          sport,
          eventKey,
          eventName,
          league,
          startTime,
          isLive,
          market: "h2h",
          outcomes,
        });
        break;
      }
    }
  }
  return events;
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

export class PokerStarsScraper extends BaseScraper {
  readonly name = "pokerstars";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  private async scrapePage(url: string, sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    const { page, ctx } = await browserManager.newPage(getProxyForScraper("pokerstars"));

    const kambiCaptures: Array<{ url: string; data: any }> = [];
    const allCaptures: Array<{ url: string; data: any }> = [];

    page.on("response", async (res: any) => {
      if (res.status() !== 200) return;
      const ct: string = res.headers()?.["content-type"] ?? "";
      if (!ct.includes("json")) return;
      const u: string = res.url();
      if (u.includes("analytics") || u.includes("hotjar")) return;
      try {
        const data = await res.json().catch(() => null);
        if (!data || JSON.stringify(data).length < 200) return;
        allCaptures.push({ url: u, data });
        if (u.includes("kambicdn") || u.includes("kambi") || u.includes("offering") || u.includes("betoffer")) {
          kambiCaptures.push({ url: u, data });
        }
      } catch { /* ok */ }
    });

    const events: ScrapedEvent[] = [];
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 55_000 });
      await dismissCookies(page);
      // Event-driven: exit as soon as first JSON capture arrives (max 10s)
      const captureDeadline = Date.now() + 10_000;
      while (allCaptures.length === 0 && Date.now() < captureDeadline) {
        await new Promise<void>((r) => setTimeout(r, 200));
      }
      if (allCaptures.length > 0) {
        await new Promise<void>((r) => setTimeout(r, 1_500));
      }

      const title = await page.title().catch(() => "");
      const pageUrl = page.url();

      // PokerStars retiró el sportsbook de España — redirige a .fr o .eu
      const isGeoRedirected = !pageUrl.includes("pokerstarssports.es") && !pageUrl.includes("pokerstars.es");
      if (isGeoRedirected) {
        this.warn(`PokerStars redirigido a ${pageUrl} — posible retirada del mercado español`);
        return [];
      }

      if (
        title.toLowerCase().includes("not found") ||
        title.toLowerCase().includes("404") ||
        pageUrl.includes("/404")
      ) {
        this.warn(`Página no disponible: ${pageUrl}`);
        return [];
      }

      if (kambiCaptures.length > 0) {
        this.log(`Kambi XHR (${kambiCaptures.length}): ${kambiCaptures.map((c) => c.url.replace(/https?:\/\/[^/]+/, "").slice(0, 60)).join(" | ")}`);
        for (const { data } of kambiCaptures) {
          events.push(...parseKambi(data, sport, isLive));
        }
      } else {
        // Intentar con todas las capturas por si Kambi está bajo otro dominio
        for (const { data } of allCaptures) {
          const parsed = parseKambi(data, sport, isLive);
          if (parsed.length > 0) { events.push(...parsed); break; }
        }
      }

      if (events.length === 0) {
        await logPageState(page, this.name);
        if (allCaptures.length > 0) {
          this.warn(`Sin eventos. Dominios capturados: ${[...new Set(allCaptures.map(c => new URL(c.url).hostname))].join(", ")}`);
        }
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
    if (!getProxyForScraper("pokerstars")) { this.log("Sin POKERSTARS_PROXY_URL — necesita proxy ES"); return []; }
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) all.push(...(await this.scrapePage(URLS[sport]!.live, sport, true)));
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (!getProxyForScraper("pokerstars")) { this.log("Sin POKERSTARS_PROXY_URL — necesita proxy ES"); return []; }
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) all.push(...(await this.scrapePage(URLS[sport]!.prematch, sport, false)));
    return all;
  }
}
