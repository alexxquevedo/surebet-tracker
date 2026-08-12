/**
 * Sportium España (Cirsa) — Kambi API directo + Playwright fallback.
 *
 * Sportium usa la plataforma Kambi. El widget en el frontend usa WebSocket/protobuf
 * para odds en tiempo real, inaccesible via intercepción XHR.
 * Estrategia: llamada directa a la Kambi Offering API (eu-offering.kambicdn.org).
 * Kambi customer ID para Sportium ES = "spses".
 * Kambi odds format: milli-odds (1750 = 1.75 decimal).
 */

import * as https from "https";
import { BaseScraper } from "./base";
import { browserManager, dismissCookies, logPageState, getProxyForScraper, saveFailedPayload, pageSemaphore } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine } from "../types";

// ─── Kambi API directa ───────────────────────────────────────────────────────
// Kambi customer ID para Sportium España: "spses"
// eu-offering.kambicdn.org es el CDN estándar de Kambi para Europa

const KAMBI_CUSTOMER = "spses";
const KAMBI_BASE = `https://eu-offering.kambicdn.org/offering/v2018/${KAMBI_CUSTOMER}`;
const KAMBI_PUSH_WS = "wss://push.kambicdn.org/live-offering";
// Subscribe channel for all live events — filter by sport after receiving
const KAMBI_PUSH_CHANNEL = `/live/offering/v2018/${KAMBI_CUSTOMER}/es_ES/events`;

const KAMBI_SPORT_FILTER: Record<Sport, string> = {
  FOOTBALL:   "FOOTBALL",
  TENNIS:     "TENNIS",
  BASKETBALL: "BASKETBALL",
};

function httpsGet(url: string): Promise<any> {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(15_000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchKambiDirect(sport: Sport, isLive: boolean): Promise<any | null> {
  const filter = KAMBI_SPORT_FILTER[sport];
  if (isLive) {
    const url = `${KAMBI_BASE}/liveEvent/get.json?lang=es&market=ES&startRowIndex=0&numberOfRows=150&filter=${filter}&includeParticipants=true`;
    return httpsGet(url);
  } else {
    const url = `${KAMBI_BASE}/betoffer/group.json?lang=es&market=ES&category=${filter}&numberOfEvents=200&clientId=2&includedBetOfferCategories=`;
    return httpsGet(url);
  }
}

// Sportium España (Cirsa) — plataforma Kambi.
// Todos los paths directos dan 404 — probamos homepage + rutas hash Kambi + rutas alternativas.
const URLS: Record<Sport, { live: string; prematch: string }[]> = {
  FOOTBALL: [
    // Homepage first — let JS router handle navigation
    { live: "https://www.sportium.es/",                            prematch: "https://www.sportium.es/" },
    // Hash-based Kambi routing (common for Kambi operators)
    { live: "https://www.sportium.es/#/sports/football/live",      prematch: "https://www.sportium.es/#/sports/football" },
    { live: "https://www.sportium.es/apostar#/sports/football/live", prematch: "https://www.sportium.es/apostar#/sports/football" },
    // Alternative path structures
    { live: "https://www.sportium.es/apuestas/en-directo/futbol",  prematch: "https://www.sportium.es/apuestas/futbol" },
    { live: "https://www.sportium.es/apuestas-deportivas/futbol",  prematch: "https://www.sportium.es/apuestas-deportivas/futbol" },
    // Legacy candidates
    { live: "https://www.sportium.es/apostar/directo/futbol",      prematch: "https://www.sportium.es/apostar/futbol" },
    { live: "https://www.sportium.es/en-directo/futbol",           prematch: "https://www.sportium.es/deportes/futbol" },
  ],
  TENNIS: [
    { live: "https://www.sportium.es/",                            prematch: "https://www.sportium.es/" },
    { live: "https://www.sportium.es/#/sports/tennis/live",        prematch: "https://www.sportium.es/#/sports/tennis" },
    { live: "https://www.sportium.es/apuestas/en-directo/tenis",   prematch: "https://www.sportium.es/apuestas/tenis" },
    { live: "https://www.sportium.es/apostar/directo/tenis",       prematch: "https://www.sportium.es/apostar/tenis" },
  ],
  BASKETBALL: [
    { live: "https://www.sportium.es/",                              prematch: "https://www.sportium.es/" },
    { live: "https://www.sportium.es/#/sports/basketball/live",      prematch: "https://www.sportium.es/#/sports/basketball" },
    { live: "https://www.sportium.es/apuestas/en-directo/baloncesto", prematch: "https://www.sportium.es/apuestas/baloncesto" },
    { live: "https://www.sportium.es/apostar/directo/baloncesto",    prematch: "https://www.sportium.es/apostar/baloncesto" },
  ],
};

const toDecimal = (raw: any): number => {
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  return n > 100 ? n / 1000 : n;
};

// ─── Kambi parsers ────────────────────────────────────────────────────────────

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

// ─── Scraper ─────────────────────────────────────────────────────────────────

// Static flag: if push.kambicdn.org is unreachable from this VPS, skip WS for 60 min
let kambiPushBlockedUntil = 0;

export class SportiumScraper extends BaseScraper {
  readonly name = "sportium";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  /**
   * Kambi push WebSocket (direct, no proxy) via blank Playwright page.
   * push.kambicdn.org is a different domain from eu-offering.kambicdn.org —
   * may not be geo-blocked from OVH datacenter IP.
   * Uses pageSemaphore ONLY once (for FOOTBALL) and caches the geo-block result.
   */
  private async fetchKambiPushWS(sport: Sport, isLive: boolean): Promise<ScrapedEvent[] | null> {
    if (!isLive) return null;
    if (Date.now() < kambiPushBlockedUntil) return null; // already known blocked
    // Only probe on FOOTBALL — if it fails, mark blocked for all sports for 60 min
    if (sport !== "FOOTBALL") return null;

    await pageSemaphore.acquire();
    const browser = await browserManager.getBrowser(); // direct, no proxy
    const ctx = await browser.newContext({ locale: "es-ES" });
    const page = await ctx.newPage();
    const kambiFrames: any[] = [];

    page.on("websocket", (ws: any) => {
      if (!ws.url().includes("kambicdn")) return;
      this.log(`Kambi WS connected: ${ws.url().slice(0, 80)}`);
      ws.on("framereceived", (frame: any) => {
        const raw = frame.payload;
        const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
        if (text.length < 5) return;
        try {
          const msg = JSON.parse(text);
          if (msg && typeof msg === "object") kambiFrames.push(msg);
        } catch { /* binary or non-JSON frame */ }
      });
      ws.on("frameclosed", () => this.log(`Kambi WS closed`));
    });

    try {
      await page.goto("about:blank", { waitUntil: "load", timeout: 10_000 });

      const wsResult: string = await page.evaluate(({ wsUrl, channel }: { wsUrl: string; channel: string }) => {
        return new Promise<string>((resolve) => {
          try {
            const ws = new WebSocket(wsUrl);
            (window as any).__kambiWS = ws;
            let opened = false;
            ws.addEventListener("open", () => {
              opened = true;
              ws.send(JSON.stringify({ type: "SUBSCRIBE", channel }));
              resolve("connected+subscribed");
            });
            ws.addEventListener("error", () => resolve("ws_error"));
            // 4s timeout: fast fail if geo-blocked
            setTimeout(() => resolve(opened ? "timeout_subscribed" : "timeout_no_connect"), 4_000);
          } catch (e) {
            resolve("exception:" + String(e));
          }
        });
      }, { wsUrl: KAMBI_PUSH_WS, channel: KAMBI_PUSH_CHANNEL });

      this.log(`Kambi push WS: ${wsResult}`);

      if (wsResult === "ws_error" || wsResult === "timeout_no_connect" || wsResult.startsWith("exception")) {
        kambiPushBlockedUntil = Date.now() + 60 * 60 * 1000; // skip for 60 min
        this.warn(`Kambi push WS bloqueado desde este IP (${wsResult}) — omitiendo 60 min`);
        return null;
      }

      // Wait for messages after subscribe (shorter window)
      await page.waitForTimeout(5_000);

      if (kambiFrames.length === 0) {
        this.warn(`Kambi push WS: 0 frames received — domain may be geo-blocked`);
        return null;
      }

      this.log(`Kambi push WS: ${kambiFrames.length} frames received`);

      // Parse frames using existing Kambi parsers
      const events: ScrapedEvent[] = [];
      const filter = KAMBI_SPORT_FILTER[sport];
      for (const frame of kambiFrames) {
        // Kambi push may wrap data in { type, payload } or send directly
        const data = frame?.payload ?? frame?.data ?? frame?.content ?? frame;
        // Filter by sport if the frame has sport info
        const frameSport: string = (frame?.sport ?? frame?.sportName ?? "").toUpperCase();
        if (frameSport && !frameSport.includes(filter)) continue;
        const parsed = isLive ? parseLive(data, sport) : parsePrematch(data, sport);
        if (parsed.length > 0) {
          this.log(`Kambi push parsed ${parsed.length} events from frame type=${frame?.type ?? "?"}`);
          events.push(...parsed);
        }
      }

      // If parsers got 0 events, log raw frame structure for analysis
      if (events.length === 0 && kambiFrames.length > 0) {
        const sample = kambiFrames[0];
        const topKeys = typeof sample === "object" ? Object.keys(sample).slice(0, 8).join(",") : String(sample).slice(0, 100);
        this.warn(`Kambi push: ${kambiFrames.length} frames but 0 events. keys: ${topKeys}`);
        this.warn(`  sample: ${JSON.stringify(sample).slice(0, 500)}`);
      }

      return events;
    } catch (err) {
      this.warn(`Kambi push WS error`, err);
      return null;
    } finally {
      try { await ctx.close(); } catch { /* ignore */ }
      pageSemaphore.release();
    }
  }

  private async scrapePage(url: string, sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    const { page, ctx } = await browserManager.newPage(getProxyForScraper('sportium'));
    const kambiCaptures: any[] = [];
    const allCaptures: Array<{ url: string; data: any }> = [];

    // Diagnostic: log ALL sportswidget.sportium.es responses to discover the events API
    page.on("response", async (res: any) => {
      const u: string = res.url();
      if (!u.includes("sportswidget.sportium.es")) return;
      const status: number = res.status();
      const ct: string = (res.headers()?.["content-type"] ?? "").split(";")[0].trim();
      this.warn(`SW ${status} [${ct}] ${u.replace(/https?:\/\/[^/]+/, "").slice(0, 100)}`);
      // Log /configuration/init body — may reveal Kambi CDN endpoint or alternative URLs
      if (u.includes("/configuration/init") && status === 200 && ct.includes("json")) {
        try {
          const body = await res.json();
          this.warn(`SW config/init: ${JSON.stringify(body).slice(0, 800)}`);
        } catch { /* ignore */ }
      }
    });

    page.on("response", async (res: any) => {
      if (res.status() !== 200) return;
      const ct: string = res.headers()?.["content-type"] ?? "";
      if (!ct.includes("json")) return;
      const u: string = res.url();
      try {
        const data = await res.json().catch(() => null);
        if (!data || JSON.stringify(data).length < 200) return;
        allCaptures.push({ url: u, data });
        // Filtro Kambi: por dominio o por estructura de URL (sin exigir extensión .json)
        // sportswidget.sportium.es es el proxy Kambi propio de Sportium (no usa kambicdn.org)
        const isKambi =
          u.includes("kambicdn") ||
          u.includes("kambi") ||
          u.includes("/offering/") ||
          u.includes("/betoffer/") ||
          u.includes("/event/") ||
          u.includes("sportswidget.sportium.es");
        if (isKambi) kambiCaptures.push(data);
      } catch { /* non-JSON */ }
    });

    const events: ScrapedEvent[] = [];
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 55_000 });
      await dismissCookies(page);
      // Sportium usa Kambi que puede tardar en cargarse — esperar más
      await page.waitForTimeout(14_000);

      const finalUrl = page.url();
      const title = await page.title().catch(() => "");
      const is404 = res404(finalUrl, title);
      if (is404) {
        this.warn(`URL 404: ${finalUrl} — Sportium puede haber cambiado paths`);
        // Si es homepage cargada sin 404, log de capturas para detectar la URL correcta de Kambi
      } else if (allCaptures.length > 0 && kambiCaptures.length === 0) {
        const domains = [...new Set(allCaptures.map((c) => new URL(c.url).hostname))];
        this.log(`Sportium homepage cargada, dominios: ${domains.join(", ")} — buscando Kambi CDN`);
      }

      if (kambiCaptures.length > 0) {
        this.log(`Kambi XHR: ${kambiCaptures.length} responses`);
        for (const data of kambiCaptures) {
          events.push(...(isLive ? parseLive(data, sport) : parsePrematch(data, sport)));
        }
        // Debug: si Kambi capturado pero 0 eventos, mostrar estructura para diagnosticar
        if (events.length === 0) {
          const sample = kambiCaptures[0];
          const topKeys = typeof sample === "object" ? Object.keys(sample ?? {}).slice(0, 12).join(",") : typeof sample;
          this.warn(`Kambi ${kambiCaptures.length} capturas pero 0 eventos. keys: ${topKeys}`);
          this.warn(`  sample: ${JSON.stringify(sample).slice(0, 600)}`);
        }
      } else if (allCaptures.length > 0) {
        // Intentar parsear cualquier respuesta JSON por si Kambi está bajo otro dominio
        for (const { data } of allCaptures) {
          const parsed = isLive ? parseLive(data, sport) : parsePrematch(data, sport);
          if (parsed.length > 0) { events.push(...parsed); break; }
        }
      }

      if (events.length === 0) {
        await logPageState(page, this.name);
        if (allCaptures.length > 0) {
          const domains = [...new Set(allCaptures.map((c) => new URL(c.url).hostname))];
          this.warn(`Sin eventos Kambi. Dominios capturados: ${domains.join(", ")}`);
        }
      } else {
        this.log(`${isLive ? "Live" : "Prematch"} ${sport}: ${events.length} events`);
      }
    } catch (err) {
      this.warn(`${sport} ${isLive ? "live" : "prematch"} failed`, err);
    } finally {
      await ctx.close();
    }
    return events;
  }

  /** Intenta múltiples URLs hasta encontrar una que cargue */
  private async scrapePageWithFallback(sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    const urlCandidates = URLS[sport];
    for (const candidate of urlCandidates) {
      const url = isLive ? candidate.live : candidate.prematch;
      const result = await this.scrapePage(url, sport, isLive);
      if (result.length > 0) return result;
    }
    return [];
  }

  private async scrapeOneSport(sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    // 0. Kambi push WebSocket probe (live FOOTBALL only — caches geo-block for 60 min)
    //    push.kambicdn.org may not be geo-blocked unlike eu-offering.kambicdn.org
    if (isLive && sport === "FOOTBALL") {
      try {
        const wsEvents = await this.fetchKambiPushWS(sport, isLive);
        if (wsEvents !== null && wsEvents.length > 0) {
          this.log(`Kambi push WS live ${sport}: ${wsEvents.length} events`);
          return wsEvents;
        }
      } catch (err) {
        this.warn(`Kambi push WS ${sport} error`, err);
      }
    }

    // 1. Try Kambi HTTP REST directly — faster and more reliable than browser scraping
    try {
      const data = await fetchKambiDirect(sport, isLive);
      if (data) {
        const events = isLive ? parseLive(data, sport) : parsePrematch(data, sport);
        if (events.length > 0) {
          this.log(`Kambi API directo ${isLive ? "live" : "prematch"} ${sport}: ${events.length} events`);
          return events;
        }
        const topKeys = typeof data === "object" ? Object.keys(data ?? {}).slice(0, 8).join(",") : typeof data;
        this.warn(`Kambi API directo ${sport}: respuesta pero 0 eventos. keys=${topKeys}`);
        this.warn(`  sample: ${JSON.stringify(data).slice(0, 400)}`);
      } else {
        this.warn(`Kambi API directo ${sport}: null (no response o error de red)`);
      }
    } catch (err) {
      this.warn(`Kambi API directo ${sport} failed`, err);
    }

    // 2. Browser fallback (for cases where Kambi API is blocked or customer ID wrong)
    return this.scrapePageWithFallback(sport, isLive);
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

function res404(url: string, title: string): boolean {
  return (
    url.includes("/404") ||
    title.toLowerCase().includes("not found") ||
    title.toLowerCase().includes("404") ||
    title.toLowerCase().includes("página no encontrada")
  );
}
