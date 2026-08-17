/**
 * Sportium España (Cirsa) — Kambi Offering API (HTTP directo, sin Playwright).
 *
 * Sportium usa la plataforma Kambi. Customer ID: "sisp".
 * Nota: eu-offering.kambicdn.org bloquea IPs de datacenter — necesita proxy residencial ES.
 */

import * as https from "https";
import axios from "axios";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import { config } from "../config";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

const KAMBI_CUSTOMER   = "sisp";
const KAMBI_BASE_V2    = `https://eu-offering.kambicdn.org/offering/v2/${KAMBI_CUSTOMER}`;
const KAMBI_BASE_V2018 = `https://eu-offering.kambicdn.org/offering/v2018/${KAMBI_CUSTOMER}`;

const KAMBI_SPORT_FILTER: Record<Sport, string> = {
  FOOTBALL:   "FOOTBALL",
  TENNIS:     "TENNIS",
  BASKETBALL: "BASKETBALL",
};

const KAMBI_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://sports.sportium.es/",
  "Origin": "https://sports.sportium.es",
  "X-Requested-With": "XMLHttpRequest",
};

const BLOCKED_STATUSES = new Set([403, 429, 451]);

function httpsGet(url: string): Promise<{ data: any; status: number }> {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: KAMBI_HEADERS }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve({ data: JSON.parse(Buffer.concat(chunks).toString()), status: res.statusCode ?? 0 }); }
        catch { resolve({ data: null, status: res.statusCode ?? 0 }); }
      });
    });
    req.on("error", () => resolve({ data: null, status: 0 }));
    req.setTimeout(15_000, () => { req.destroy(); resolve({ data: null, status: 0 }); });
  });
}

async function httpsGetWithProxy(url: string, proxyUrl: string): Promise<any | null> {
  try {
    const u = new URL(proxyUrl);
    const instance = axios.create({
      timeout: 15_000,
      headers: KAMBI_HEADERS,
      proxy: {
        protocol: u.protocol.replace(":", "") as "http" | "https",
        host: u.hostname,
        port: parseInt(u.port, 10),
        ...(u.username ? { auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } } : {}),
      },
    });
    const res = await instance.get(url);
    return res.data ?? null;
  } catch (err: any) {
    if ((err?.response?.status ?? 0) === 407) {
      console.error("[sportium] CRITICAL_PROXY_AUTH_FAIL — proxy retornó 407. Verifica credenciales en SPORTIUM_PROXY_URL.");
    }
    return null;
  }
}

async function fetchKambiDirect(sport: Sport, isLive: boolean): Promise<any | null> {
  const filter = KAMBI_SPORT_FILTER[sport].toLowerCase();
  const proxyUrl = config.scraperProxies.sportium;

  const withProxyFallback = async (url: string, directResult: { data: any; status: number }): Promise<any | null> => {
    if (BLOCKED_STATUSES.has(directResult.status) && proxyUrl) {
      return httpsGetWithProxy(url, proxyUrl);
    }
    return directResult.data;
  };

  if (isLive) {
    const urlV2 = `${KAMBI_BASE_V2}/listView/${filter}/${filter}/all/all/in-play.json?lang=es&market=ES&includeParticipants=true`;
    const r2 = await httpsGet(urlV2);
    const v2result = BLOCKED_STATUSES.has(r2.status) ? await withProxyFallback(urlV2, r2) : r2.data;
    if (v2result?.liveEvents?.length || v2result?.events?.length) return v2result;

    const urlFallback = `${KAMBI_BASE_V2018}/liveEvent/get.json?lang=es&market=ES&startRowIndex=0&numberOfRows=150&filter=${filter.toUpperCase()}&includeParticipants=true`;
    const rf = await httpsGet(urlFallback);
    return BLOCKED_STATUSES.has(rf.status) ? withProxyFallback(urlFallback, rf) : rf.data;
  } else {
    const urlV2 = `${KAMBI_BASE_V2}/listView/${filter}/${filter}/all/all.json?lang=es&market=ES&numberOfEvents=200`;
    const r2 = await httpsGet(urlV2);
    const v2result = BLOCKED_STATUSES.has(r2.status) ? await withProxyFallback(urlV2, r2) : r2.data;
    if (v2result?.events?.length) return v2result;

    const urlFallback = `${KAMBI_BASE_V2018}/betoffer/group.json?lang=es&market=ES&category=${filter.toUpperCase()}&numberOfEvents=200&clientId=2&includedBetOfferCategories=`;
    const rf = await httpsGet(urlFallback);
    return BLOCKED_STATUSES.has(rf.status) ? withProxyFallback(urlFallback, rf) : rf.data;
  }
}

const toDecimal = (raw: any): number => {
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  return n > 100 ? n / 1000 : n;
};

function parseLive(data: any, sport: Sport): ScrapedEvent[] {
  const eventList: any[] = data?.liveEvents ?? data?.events ?? [];
  const events: ScrapedEvent[] = [];
  for (const item of eventList) {
    const ev = item.event ?? item;
    const eventName: string = ev.name ?? "";
    if (!eventName) continue;
    const eventKey = buildEventKey(sport, eventName);
    for (const offer of (item.betOffers ?? [])) {
      const label = (offer.criterion?.label ?? "").toLowerCase();
      if (label.includes("1x2") || label.includes("full time") || label.includes("resultado")) {
        const h2h: H2HOutcome[] = (offer.outcomes ?? [])
          .map((o: any) => {
            const odds = toDecimal(o.odds);
            return odds >= 1.01 ? { name: o.label ?? o.type, odds } : null;
          })
          .filter(Boolean) as H2HOutcome[];
        if (h2h.length >= 2) {
          events.push({ bookmaker: "sportium", sport, eventKey, eventName, isLive: true, market: "h2h", outcomes: h2h });
          break;
        }
      }
    }
  }
  return events;
}

function parsePrematch(data: any, sport: Sport): ScrapedEvent[] {
  const events: ScrapedEvent[] = [];
  const walk = (groups: any[]): void => {
    for (const g of groups) {
      for (const item of (g.events ?? [])) {
        const ev = item.event ?? item;
        const eventName: string = ev.name ?? "";
        if (!eventName) continue;
        const startTime = ev.start ? new Date(ev.start) : undefined;
        const eventKey = buildEventKey(sport, eventName, startTime);
        for (const offer of (item.betOffers ?? [])) {
          const label = (offer.criterion?.label ?? "").toLowerCase();
          if (label.includes("1x2") || label.includes("full time") || label.includes("resultado")) {
            const h2h: H2HOutcome[] = (offer.outcomes ?? [])
              .map((o: any) => {
                const odds = toDecimal(o.odds);
                return odds >= 1.01 ? { name: o.label ?? o.type, odds } : null;
              })
              .filter(Boolean) as H2HOutcome[];
            if (h2h.length >= 2) {
              events.push({ bookmaker: "sportium", sport, eventKey, eventName, startTime, isLive: false, market: "h2h", outcomes: h2h });
              break;
            }
          }
        }
      }
      if (Array.isArray(g.groups)) walk(g.groups);
    }
  };
  walk(data?.groups ?? []);
  return events;
}

export class SportiumScraper extends BaseScraper {
  readonly name = "sportium";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  private async scrapeOneSport(sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    try {
      const data = await fetchKambiDirect(sport, isLive);
      if (data) {
        const events = isLive ? parseLive(data, sport) : parsePrematch(data, sport);
        if (events.length > 0) {
          this.log(`Kambi API ${isLive ? "live" : "prematch"} ${sport}: ${events.length} events`);
          return events;
        }
        const topKeys = typeof data === "object" ? Object.keys(data ?? {}).slice(0, 8).join(",") : typeof data;
        this.warn(`Kambi API ${sport}: respuesta pero 0 eventos. keys=${topKeys}`);
        this.warn(`  sample: ${JSON.stringify(data).slice(0, 400)}`);
      } else {
        this.warn(`Kambi API ${sport}: null — posible geo-block (necesita proxy residencial ES)`);
      }
    } catch (err) {
      this.warn(`Kambi API ${sport} failed`, err);
    }
    return [];
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) all.push(...(await this.scrapeOneSport(sport, true)));
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) all.push(...(await this.scrapeOneSport(sport, false)));
    return all;
  }
}
