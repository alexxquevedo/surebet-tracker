/**
 * Altenar B2B platform scraper — Spanish bookmakers.
 *
 * Bookmakers on Altenar: Luckia, Casino Gran Madrid, TonyBet ES
 * API: sb2frontend-altenar2.licence.widgets.altenar.com
 *
 * Requires Spanish ISP proxy (ALTENAR_PROXY_URL) — CDN blocks datacenter IPs.
 *
 * Usage: new AltenarScraper("luckia",           "Luckia")
 *        new AltenarScraper("casino-gran-madrid","CasinoGranMadrid")
 *        new AltenarScraper("tonybet",           "TonyBet")
 */

import axios from "axios";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import { config } from "../config";
import { createProxiedAxios } from "./proxy-helper";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

// Altenar sport IDs (confirmed: football=66, tennis=80, basketball=67)
const ALTENAR_SPORT_IDS: Partial<Record<Sport, number>> = {
  FOOTBALL:   66,
  TENNIS:     80,
  BASKETBALL: 67,
};

const ALTENAR_CDN = "https://sb2frontend-altenar2.licence.widgets.altenar.com";

// ─── Type stubs ──────────────────────────────────────────────────────────────

interface AltenarSelection {
  Id?: number;
  Name?: string;
  Price?: number;
  Status?: string;
  IsActive?: boolean;
}

interface AltenarMarket {
  Id?: number;
  Name?: string;
  CategoryName?: string;
  Selections?: AltenarSelection[];
  IsMain?: boolean;
  OrderPosition?: number;
}

interface AltenarEvent {
  Id?: number;
  Name?: string;
  Home?: string;
  Away?: string;
  TeamHome?: string;
  TeamAway?: string;
  MatchStatus?: string; // "InProgress" | "Prematch"
  Markets?: AltenarMarket[];
  MainMarket?: AltenarMarket;
  StartDate?: string;
  SportId?: number;
  CategoryId?: number;
}

interface AltenarResponse {
  Result?: AltenarEvent[];
  Events?: AltenarEvent[];
  Data?: { Events?: AltenarEvent[] };
}

// ─── Parser ──────────────────────────────────────────────────────────────────

function isH2HMarket(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "1x2" || n === "match result" || n === "resultado" ||
    n === "winner" || n === "ganador del partido" ||
    n.startsWith("full time result") || n.startsWith("ft 1x2") ||
    n.includes("match winner") || n.includes("resultado final")
  );
}

function parseAltenarResponse(
  data: unknown,
  bookmaker: string,
  sport: Sport,
  isLive: boolean,
): ScrapedEvent[] {
  if (!data || typeof data !== "object") return [];

  const raw = data as AltenarResponse;
  const items: AltenarEvent[] =
    raw.Result ?? raw.Events ?? raw.Data?.Events ?? [];

  if (!Array.isArray(items) || items.length === 0) return [];

  const results: ScrapedEvent[] = [];

  for (const ev of items) {
    // Filter live / prematch
    const status = String(ev.MatchStatus ?? "").toLowerCase();
    const evIsLive = status === "inprogress" || status === "in_progress" || status.includes("live");
    if (isLive !== evIsLive) continue;

    // Team names
    const home = ev.Home ?? ev.TeamHome ?? "";
    const away = ev.Away ?? ev.TeamAway ?? "";
    const eventName = ev.Name ?? (home && away ? `${home} - ${away}` : "");
    if (!eventName) continue;

    // Find H2H market
    const allMarkets: AltenarMarket[] = ev.Markets ?? (ev.MainMarket ? [ev.MainMarket] : []);
    const mainMkt =
      allMarkets.find(m => m.IsMain === true) ??
      allMarkets.find(m => isH2HMarket(m.Name ?? m.CategoryName ?? "")) ??
      allMarkets.find(m => (m.Selections?.length ?? 0) >= 2 && (m.Selections?.length ?? 0) <= 3);

    if (!mainMkt) continue;

    const outcomes: H2HOutcome[] = (mainMkt.Selections ?? [])
      .filter(s => s.Status !== "Suspended" && s.IsActive !== false)
      .map(s => {
        const odds = typeof s.Price === "number"
          ? s.Price
          : parseFloat(String(s.Price ?? "0"));
        const name = s.Name ?? "";
        return odds >= 1.01 && name ? { name, odds } : null;
      })
      .filter((x): x is H2HOutcome => x !== null);

    if (outcomes.length < 2) continue;

    const startTime = ev.StartDate ? new Date(ev.StartDate) : undefined;
    const eventKey = buildEventKey(sport, eventName, startTime);
    results.push({ bookmaker, sport, eventKey, eventName, startTime, isLive, market: "h2h", outcomes });
  }

  return results;
}

// ─── Scraper class ────────────────────────────────────────────────────────────

export class AltenarScraper extends BaseScraper {
  readonly name: string;
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];
  private readonly integrationId: string;

  constructor(bookmaker: string, integrationId: string) {
    super();
    this.name = bookmaker;
    this.integrationId = integrationId;

    // Altenar-specific proxy override.
    // Supports both HTTP (http://host:port) and SOCKS5 (socks5://host:port) proxy URLs.
    const proxyUrl = (config.scraperProxies as any).altenar as string | undefined;
    if (proxyUrl) {
      this.http = createProxiedAxios(proxyUrl, 20_000, {
        "Origin":  `https://www.${bookmaker}.es`,
        "Referer": `https://www.${bookmaker}.es/`,
      });
    } else {
      // No proxy — minimal headers to avoid 403
      this.http = axios.create({
        timeout: 20_000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept": "application/json, */*",
          "Accept-Language": "es-ES,es;q=0.9",
          "Origin": `https://www.${bookmaker}.es`,
        },
      });
    }
  }

  private buildUrl(sport: Sport, isLive: boolean): string {
    const sportId = ALTENAR_SPORT_IDS[sport] ?? 0;
    const base = `${ALTENAR_CDN}/api/Sportsbook/GetEvents`;
    const params = new URLSearchParams({
      culture: "es-ES",
      integration: this.integrationId,
      sportIds: String(sportId),
      count: "200",
    });
    if (isLive) params.set("isLive", "true");
    return `${base}?${params}`;
  }

  private async scrapeForSport(sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    const url = this.buildUrl(sport, isLive);
    try {
      const { data } = await this.http.get(url);
      const events = parseAltenarResponse(data, this.name, sport, isLive);
      this.log(`${isLive ? "live" : "prematch"} ${sport}: ${events.length} events`);
      return events;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 402 || status === 403) {
        this.warn(`${sport} ${isLive ? "live" : "prematch"}: HTTP ${status} — bloqueado por Altenar CDN (necesita proxy ES)`);
      } else if (!err?.response) {
        this.warn(`${sport} ${isLive ? "live" : "prematch"}: sin respuesta — posible DNS/geo-block o proxy caído`);
      } else {
        this.warn(`${sport} ${isLive ? "live" : "prematch"} falló HTTP ${status}`, err?.message);
      }
      return [];
    }
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    if (!config.scraperProxies.altenar) { this.log("Sin ALTENAR_PROXY_URL — necesita proxy ES"); return []; }
    const settled = await Promise.allSettled(
      this.sports.map(s => this.scrapeForSport(s, true))
    );
    return settled.flatMap(r => r.status === "fulfilled" ? r.value : []);
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (!config.scraperProxies.altenar) { this.log("Sin ALTENAR_PROXY_URL — necesita proxy ES"); return []; }
    const settled = await Promise.allSettled(
      this.sports.map(s => this.scrapeForSport(s, false))
    );
    return settled.flatMap(r => r.status === "fulfilled" ? r.value : []);
  }
}
