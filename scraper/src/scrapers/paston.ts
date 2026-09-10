/**
 * Pastón España — scraper HTTP.
 *
 * Pastón.es está licenciada por DGOJ. La plataforma es SBTech (Sportradar).
 * Los endpoints API son:
 *   - Oferta live:     https://sbapi.paston.es/api/LiveFeed/GetEventsBySubscription
 *   - Oferta prematch: https://sbapi.paston.es/api/Pre/GetEventsBySubscription
 *
 * TODO: confirmar endpoints con DevTools en paston.es → Pestaña Red → XHR/Fetch
 *       - Buscar llamadas a "sbapi" o "GetEvents" con JSON de eventos
 *       - Verificar estructura: { Events: [{ EventId, Name, SportId, Markets: [...] }] }
 *
 * Si la plataforma no es SBTech, buscar en cabeceras X-Powered-By o bundles JS.
 * Alternativas frecuentes para operadores españoles DGOJ: Kambi, Oryx (Bragg), Everymatrix.
 */

import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import { createProxiedAxios } from "./proxy-helper";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";
import { config } from "../config";

const BASE_LIVE     = "https://sbapi.paston.es/api/LiveFeed/GetEventsBySubscription";
const BASE_PREMATCH = "https://sbapi.paston.es/api/Pre/GetEventsBySubscription";

// SBTech sport IDs — confirm from live traffic
const SPORT_IDS: Partial<Record<Sport, number>> = {
  FOOTBALL:         1,
  BASKETBALL:       2,
  TENNIS:           5,
  ICEHOCKEY:        4,
  AMERICANFOOTBALL: 16,
  BASEBALL:         3,
};

const DEFAULT_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "es-ES,es;q=0.9",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Referer: "https://www.paston.es/",
  Origin: "https://www.paston.es",
};

export class PastonScraper extends BaseScraper {
  readonly name = "paston";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "ICEHOCKEY", "AMERICANFOOTBALL", "BASEBALL"];

  private client = (() => {
    const proxyUrl = config.scraperProxies.paston;
    return createProxiedAxios(proxyUrl, 30_000, DEFAULT_HEADERS);
  })();

  private async fetchEvents(url: string, sportId: number): Promise<any> {
    const resp = await this.client.get(url, {
      params: { sportId, lang: "es" },
    });
    return resp.data;
  }

  private parseEvents(data: any, sport: Sport, isLive: boolean): ScrapedEvent[] {
    const events: ScrapedEvent[] = [];

    // SBTech response shape (inferred — verify from live traffic):
    // { Events: [{ EventId, Name, CompetitionName, StartDate, Markets: [{ MarketType, Selections: [{ Name, Price }] }] }] }
    const evList: any[] = data?.Events ?? data?.events ?? data?.data?.Events ?? (Array.isArray(data) ? data : []);

    for (const ev of evList) {
      const eventName: string = ev.Name ?? ev.EventName ?? ev.name ?? "";
      if (!eventName) continue;

      const startTime = ev.StartDate ?? ev.StartTime ?? ev.kickOff;
      const league: string = ev.CompetitionName ?? ev.competition ?? ev.league ?? "";
      const eventKey = buildEventKey(sport, eventName, startTime ? new Date(startTime) : undefined);

      // Main market: MarketType 1 = 1X2 (football) or Winner (tennis/basketball)
      const mkt = (ev.Markets ?? ev.markets ?? []).find((m: any) =>
        m.MarketType === 1 || m.marketTypeId === 1
        || /1x2|match.result|winner|ganador/i.test(m.MarketTypeName ?? m.name ?? "")
      ) ?? (ev.Markets ?? ev.markets ?? [])[0];

      if (!mkt) continue;
      const selections: any[] = mkt.Selections ?? mkt.selections ?? mkt.outcomes ?? [];
      const outcomes: H2HOutcome[] = selections.map((s: any) => ({
        name: s.Name ?? s.name ?? s.selectionName ?? "",
        odds: parseFloat(s.Price ?? s.odds ?? s.decimalPrice ?? "0"),
      })).filter((o) => o.odds > 1);

      if (outcomes.length >= 2) {
        events.push({
          bookmaker: "paston",
          sport,
          eventKey,
          eventName,
          league: league || undefined,
          startTime: startTime ? new Date(startTime) : undefined,
          isLive,
          market: "h2h",
          outcomes,
        });
      }
    }

    return events;
  }

  private async scrapeAll(isLive: boolean): Promise<ScrapedEvent[]> {
    const url = isLive ? BASE_LIVE : BASE_PREMATCH;
    const all: ScrapedEvent[] = [];

    for (const sport of this.sports) {
      const sportId = SPORT_IDS[sport];
      if (!sportId) continue;
      try {
        const data = await this.fetchEvents(url, sportId);
        const evs = this.parseEvents(data, sport, isLive);
        all.push(...evs);
      } catch (err) {
        this.warn(`${sport} failed`, err);
      }
    }

    if (!all.length) {
      this.warn("0 events — verify API endpoint and response structure via DevTools on paston.es");
    } else {
      this.log(`${isLive ? "Live" : "Prematch"}: ${all.length} events`);
    }

    return all;
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    return this.scrapeAll(true);
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    return this.scrapeAll(false);
  }
}
