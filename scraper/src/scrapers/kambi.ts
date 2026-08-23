/**
 * Kambi B2B platform scraper — covers multiple Spanish bookmakers from one class.
 *
 * Bookmakers using Kambi: LeoVegas, 888sport, Casumo (+ betsson_es via betsson clientId)
 * API: eu-offering.kambicdn.org — requires Spanish ISP sticky proxy (same CDN that blocks Sportium)
 *
 * Usage: new KambiScraper("leovegas",  "leovegas")
 *        new KambiScraper("888sport",  "888sport")
 *        new KambiScraper("casumo",    "casumo")
 *        new KambiScraper("betsson_es","betsson")
 *
 * Proxy env var: KAMBI_PROXY_URL=http://user:pass@host:port (Spanish ISP sticky session required)
 */

import axios from "axios";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import { config } from "../config";
import { createProxiedAxios } from "./proxy-helper";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

// Our Sport → Kambi URL path segment (same string used twice in the path)
// Partial because only core sports are confirmed; new sports added when proxy allows verification.
const SPORT_PATH: Partial<Record<Sport, string>> = {
  FOOTBALL:        "football",
  TENNIS:          "tennis",
  BASKETBALL:      "basketball",
  AMERICANFOOTBALL:"american-football",
  ICEHOCKEY:       "ice-hockey",
  BASEBALL:        "baseball",
  RUGBYLEAGUE:     "rugby-league",
};

// Kambi CDN — same host as Sportium uses (eu-offering.kambicdn.org).
// URL patterns (verified via Sportium scraper):
//   Prematch: /offering/v2/{clientId}/listView/{sport}/{sport}/all/all.json?lang=es&market=ES&numberOfEvents=200
//   Live:     /offering/v2/{clientId}/listView/{sport}/{sport}/all/all/in-play.json?lang=es&market=ES&includeParticipants=true
// Client IDs: "leovegas", "888sport", "casumo", "betsson" for ES market.
// Note: some Kambi clients use "{brand}es" suffix (e.g. "sportiumes") — adjust if needed.
const KAMBI_CDN = "https://eu-offering.kambicdn.org";

interface KambiOutcome {
  label?: string;
  englishLabel?: string;
  type?: string;
  odds?: number;
}

interface KambiBetOffer {
  main?: boolean;
  outcomes?: KambiOutcome[];
}

interface KambiEventData {
  id: number;
  name?: string;
  englishName?: string;
  homeName?: string;
  awayName?: string;
  sport?: string;
  state?: string;
  start?: string;
  participants?: Array<{ name: string; type?: string }>;
}

interface KambiItem {
  event?: KambiEventData;
  betOffers?: KambiBetOffer[];
  mainBetOffer?: KambiBetOffer;
}

function parseKambiResponse(data: unknown, bookmaker: string, sport: Sport, isLive: boolean): ScrapedEvent[] {
  const items: KambiItem[] = (data as any)?.events ?? [];
  if (!Array.isArray(items) || items.length === 0) return [];

  const results: ScrapedEvent[] = [];

  for (const item of items) {
    const ev = item.event;
    if (!ev) continue;

    // State filter: "STARTED" = live, "NOT_STARTED" = prematch
    const state = String(ev.state ?? "").toUpperCase();
    if (isLive && state !== "STARTED") continue;
    if (!isLive && state !== "NOT_STARTED") continue;

    // Resolve team names — Kambi returns them in participants[] with type "home"/"away"
    const parts = ev.participants ?? [];
    const home = parts.find(p => p.type === "home")?.name ?? ev.homeName ?? parts[0]?.name ?? "";
    const away = parts.find(p => p.type === "away")?.name ?? ev.awayName ?? parts[1]?.name ?? "";
    const eventName = ev.englishName ?? ev.name ?? (home && away ? `${home} - ${away}` : "");
    if (!eventName) continue;

    // Find main bet offer (1X2 for football, winner for tennis/basketball)
    const allOffers = item.betOffers ?? (item.mainBetOffer ? [item.mainBetOffer] : []);
    const main = allOffers.find(o => o.main === true)
      ?? allOffers.find(o => {
        const n = o.outcomes?.length ?? 0;
        return n >= 2 && n <= 3;
      });
    if (!main) continue;

    // Parse outcomes — Kambi odds are in thousandths (1700 = 1.70)
    const h2h: H2HOutcome[] = (main.outcomes ?? []).map(o => {
      const odds = typeof o.odds === "number"
        ? o.odds / 1000
        : parseFloat(String(o.odds ?? "0")) / 1000;
      const name = o.englishLabel ?? o.label ?? String(o.type ?? "");
      if (odds < 1.01 || !name) return null;
      return { name, odds };
    }).filter((x): x is H2HOutcome => x !== null);

    if (h2h.length < 2) continue;

    const startTime = ev.start ? new Date(ev.start) : undefined;
    const eventKey = buildEventKey(sport, eventName, startTime);
    results.push({ bookmaker, sport, eventKey, eventName, startTime, isLive, market: "h2h", outcomes: h2h });
  }

  return results;
}

export class KambiScraper extends BaseScraper {
  readonly name: string;
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "AMERICANFOOTBALL", "RUGBYLEAGUE"];
  private readonly clientId: string;

  constructor(bookmaker: string, clientId: string) {
    super(); // sets this.http with global proxy
    this.name = bookmaker;
    this.clientId = clientId;

    // Override http client with Kambi-specific proxy if KAMBI_PROXY_URL is set.
    // Supports both HTTP (http://host:port) and SOCKS5 (socks5://host:port) proxy URLs.
    const proxyUrl = config.scraperProxies.kambi;
    if (proxyUrl) {
      this.http = createProxiedAxios(proxyUrl, 25_000, {
        Referer: `https://www.${bookmaker}.es/`,
      });
    }
  }

  private async scrapeForSport(sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    const sp = SPORT_PATH[sport];
    if (!sp) return [];
    const base = `${KAMBI_CDN}/offering/v2/${this.clientId}/listView/${sp}/${sp}/all/all`;
    const url = isLive
      ? `${base}/in-play.json?lang=es&market=ES&includeParticipants=true`
      : `${base}.json?lang=es&market=ES&numberOfEvents=200`;

    try {
      const { data } = await this.http.get(url);
      const events = parseKambiResponse(data, this.name, sport, isLive);
      this.log(`${isLive ? "live" : "prematch"} ${sport}: ${events.length} eventos`);
      return events;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 402 || status === 403) {
        this.warn(`${sport} ${isLive ? "live" : "prematch"}: HTTP ${status} — bloqueado por Kambi CDN (necesita proxy ES)`);
      } else {
        this.warn(`${sport} ${isLive ? "live" : "prematch"} falló`, err);
      }
      return [];
    }
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    if (!config.scraperProxies.kambi) { this.log("Sin KAMBI_PROXY_URL — necesita proxy ES"); return []; }
    const settled = await Promise.allSettled(
      this.sports.map(s => this.scrapeForSport(s, true))
    );
    return settled.flatMap(r => r.status === "fulfilled" ? r.value : []);
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (!config.scraperProxies.kambi) { this.log("Sin KAMBI_PROXY_URL — necesita proxy ES"); return []; }
    const settled = await Promise.allSettled(
      this.sports.map(s => this.scrapeForSport(s, false))
    );
    return settled.flatMap(r => r.status === "fulfilled" ? r.value : []);
  }
}
