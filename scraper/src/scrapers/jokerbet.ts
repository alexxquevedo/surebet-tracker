/**
 * JokerBet España — scraper HTTP.
 *
 * JokerBet.es está licenciada por DGOJ. La plataforma es Sportradar Betradar
 * (SBTech fue adquirida por Sportradar en 2021). Los endpoints API son:
 *   - Oferta live:     https://offerws.sports.jokerbet.es/v1/sports/offer?lang=es&offerType=0
 *   - Oferta prematch: https://offerws.sports.jokerbet.es/v1/sports/offer?lang=es&offerType=2
 *
 * TODO: confirmar endpoints con DevTools en jokerbet.es → Pestaña Red → XHR/Fetch
 *       - Buscar llamadas a "offerws" o "offer" con JSON de eventos
 *       - Verificar estructura de respuesta (sport_id, market_type, event_name, odds)
 *
 * Si la plataforma no es Sportradar sino Kambi u otra, consultar el campo
 * X-Powered-By o los bundles JS para identificar el vendor.
 */

import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import { createProxiedAxios } from "./proxy-helper";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";
import { config } from "../config";

const BASE = "https://offerws.sports.jokerbet.es/v1/sports/offer";

// Sportradar/SBTech sport IDs — confirm from live traffic
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
  Referer: "https://www.jokerbet.es/",
  Origin: "https://www.jokerbet.es",
};

export class JokerBetScraper extends BaseScraper {
  readonly name = "jokerbet";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "ICEHOCKEY", "AMERICANFOOTBALL", "BASEBALL"];

  private client = (() => {
    const proxyUrl = config.scraperProxies.jokerbet;
    return createProxiedAxios(proxyUrl, 30_000, DEFAULT_HEADERS);
  })();

  private async fetchOffer(offerType: 0 | 2): Promise<any> {
    const resp = await this.client.get(BASE, {
      params: { lang: "es", offerType },
    });
    return resp.data;
  }

  private parseEvents(data: any, isLive: boolean): ScrapedEvent[] {
    const events: ScrapedEvent[] = [];

    // Sportradar/SBTech response shape (inferred — verify from live traffic):
    // { sports: [{ sportId, sportName, categories: [{ events: [{ id, name, odds, ... }] }] }] }
    const sports: any[] = Array.isArray(data?.sports) ? data.sports
      : Array.isArray(data?.data?.sports) ? data.data.sports
      : Array.isArray(data) ? data
      : [];

    for (const s of sports) {
      const sportId: number = s.sportId ?? s.id ?? s.sport_id;
      const sportEntry = Object.entries(SPORT_IDS).find(([, id]) => id === sportId);
      if (!sportEntry) continue;
      const sport = sportEntry[0] as Sport;

      const categories: any[] = s.categories ?? s.leagues ?? s.competitions ?? [];
      for (const cat of categories) {
        const league: string = cat.categoryName ?? cat.name ?? cat.league ?? "";
        const evList: any[] = cat.events ?? cat.matches ?? cat.items ?? [];

        for (const ev of evList) {
          const eventName: string = ev.eventName ?? ev.name ?? ev.match ?? "";
          if (!eventName) continue;

          const startTime = ev.startTime ?? ev.kickOff ?? ev.matchTime;
          const eventKey = buildEventKey(sport, eventName, startTime ? new Date(startTime) : undefined);

          // Main market (h2h)
          const mkt = ev.markets?.find((m: any) =>
            /1x2|match.result|winner|ganador/i.test(m.marketName ?? m.name ?? "")
          ) ?? ev.markets?.[0];

          if (!mkt) continue;
          const runners: any[] = mkt.runners ?? mkt.selections ?? mkt.outcomes ?? [];
          const outcomes: H2HOutcome[] = runners.map((r: any) => ({
            name: r.runnerName ?? r.name ?? r.selectionName ?? "",
            odds: parseFloat(r.decimalPrice ?? r.odds ?? r.price ?? "0"),
          })).filter((o) => o.odds > 1);

          if (outcomes.length >= 2) {
            events.push({
              bookmaker: "jokerbet",
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
      }
    }

    if (!events.length) {
      this.warn("0 events parsed — verify API endpoint and response structure via DevTools");
    } else {
      this.log(`${isLive ? "Live" : "Prematch"}: ${events.length} events`);
    }

    return events;
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    try {
      const data = await this.fetchOffer(0);
      return this.parseEvents(data, true);
    } catch (err) {
      this.warn("Live scrape failed", err);
      return [];
    }
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    try {
      const data = await this.fetchOffer(2);
      return this.parseEvents(data, false);
    } catch (err) {
      this.warn("Prematch scrape failed", err);
      return [];
    }
  }
}
