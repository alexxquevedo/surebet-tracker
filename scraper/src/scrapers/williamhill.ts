/**
 * William Hill España — Playwright scraper.
 *
 * WH ES usa una plataforma SPA. El problema anterior: el filtro de dominio solo capturaba
 * "williamhill" pero la API de cuotas va a dominios externos (OpenBet/SBTech/Altenar).
 *
 * Fix: capturamos TODAS las respuestas JSON independientemente del dominio,
 * y probamos múltiples parsers (Altenar, Kambi, OpenBet, genérico).
 */

import { BaseScraper } from "./base";
import { browserManager, dismissCookies, parseOdds, logPageState, getProxyForScraper, saveFailedPayload } from "./playwright-base";
import type { BrowserContext } from "playwright";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

// WilliamHill España — múltiples candidatos de URL
// La plataforma cambió a 888sport; puede que el SPA use rutas distintas
const URL_CANDIDATES: Partial<Record<Sport, { live: string[]; prematch: string[] }>> = {
  FOOTBALL: {
    live: [
      "https://www.williamhill.es/es-es/sports/football/live",
      "https://www.williamhill.es/es-es/in-play/football",
      "https://www.williamhill.es/es-es/apuestas/futbol/en-directo",
    ],
    prematch: [
      "https://www.williamhill.es/es-es/sports/football",
      "https://www.williamhill.es/es-es/apuestas/futbol",
      "https://www.williamhill.es/es-es/betting/football",
    ],
  },
  TENNIS: {
    live: [
      "https://www.williamhill.es/es-es/sports/tennis/live",
      "https://www.williamhill.es/es-es/in-play/tennis",
    ],
    prematch: [
      "https://www.williamhill.es/es-es/sports/tennis",
      "https://www.williamhill.es/es-es/apuestas/tenis",
    ],
  },
  BASKETBALL: {
    live: [
      "https://www.williamhill.es/es-es/sports/basketball/live",
      "https://www.williamhill.es/es-es/in-play/basketball",
    ],
    prematch: [
      "https://www.williamhill.es/es-es/sports/basketball",
      "https://www.williamhill.es/es-es/apuestas/baloncesto",
    ],
  },
};

// ─── Parsers para distintas plataformas ──────────────────────────────────────

/** Altenar / biahosted: { Result: { Items: [{ Name, HomeTeamName, AwayTeamName, Markets: [{ Name, Selections: [{ Name, Odd }] }] }] } } */
function parseAltenar(data: any, bookmaker: string, sport: Sport, isLive: boolean): ScrapedEvent[] {
  const items: any[] = data?.Result?.Items ?? data?.Items ?? data?.items ?? [];
  if (!items.length) return [];
  const events: ScrapedEvent[] = [];
  for (const item of items) {
    const home: string = item.HomeTeamName ?? item.homeName ?? "";
    const away: string = item.AwayTeamName ?? item.awayName ?? "";
    const eventName = home && away ? `${home} - ${away}` : (item.Name ?? item.EventName ?? "");
    if (!eventName) continue;
    const startTime = item.StartDate ? new Date(item.StartDate) : undefined;
    const eventKey = buildEventKey(sport, eventName, startTime);
    for (const market of (item.Markets ?? item.markets ?? [])) {
      const mName: string = (market.Name ?? market.name ?? "").toLowerCase();
      if (mName.includes("1x2") || mName.includes("resultado") || mName.includes("match result") ||
          mName.includes("winner") || mName.includes("vainqueur") || mName.includes("ganador")) {
        const sels: any[] = market.Selections ?? market.selections ?? market.outcomes ?? [];
        const outcomes: H2HOutcome[] = sels
          .map((s: any) => {
            const odds = parseFloat(String(s.Odd ?? s.odd ?? s.price ?? s.odds ?? 0));
            const name: string = s.Name ?? s.name ?? s.label ?? "";
            return odds >= 1.01 && name ? { name, odds } : null;
          })
          .filter(Boolean) as H2HOutcome[];
        if (outcomes.length >= 2) {
          events.push({ bookmaker, sport, eventKey, eventName, startTime, isLive, market: "h2h", outcomes });
          break;
        }
      }
    }
  }
  return events;
}

/** Kambi: { events/liveEvents: [{ event: { name, homeName, awayName }, betOffers: [{ criterion, outcomes: [{ label, odds }] }] }] } */
function parseKambi(data: any, bookmaker: string, sport: Sport, isLive: boolean): ScrapedEvent[] {
  const eventList: any[] = data?.liveEvents ?? data?.events ?? data?.offeringEvents?.events ?? [];
  if (!eventList.length) return [];
  const events: ScrapedEvent[] = [];
  for (const item of eventList) {
    const ev = item.event ?? item;
    const eventName: string = ev.name ?? `${ev.homeName ?? ""} - ${ev.awayName ?? ""}`;
    if (!eventName) continue;
    const startTime = ev.start ? new Date(ev.start) : undefined;
    const eventKey = buildEventKey(sport, eventName, startTime);
    for (const offer of (item.betOffers ?? [])) {
      const label: string = (offer.criterion?.label ?? offer.betOfferType?.name ?? "").toLowerCase();
      if (label.includes("1x2") || label.includes("full time") || label.includes("resultado") ||
          label.includes("match result") || label.includes("winner")) {
        const outcomes: H2HOutcome[] = (offer.outcomes ?? [])
          .map((o: any) => {
            const rawOdds = o.odds ?? o.decimalOdds ?? 0;
            const odds = rawOdds > 100 ? rawOdds / 1000 : Number(rawOdds);
            const name: string = o.label ?? o.type ?? "";
            return odds >= 1.01 && name ? { name, odds } : null;
          })
          .filter(Boolean) as H2HOutcome[];
        if (outcomes.length >= 2) {
          events.push({ bookmaker, sport, eventKey, eventName, startTime, isLive, market: "h2h", outcomes });
          break;
        }
      }
    }
  }
  return events;
}

/** OpenBet / SBTech genérico: busca arrays de fixtures/events con markets/prices */
function parseOpenBet(data: any, bookmaker: string, sport: Sport, isLive: boolean): ScrapedEvent[] {
  // OpenBet structures vary; try several common shapes
  const containers = [
    data?.response?.dataList,
    data?.dataList,
    data?.events,
    data?.fixtures,
    data?.EventList,
    data?.data?.events,
    ...(Array.isArray(data) ? [data] : []),
  ].filter(Boolean);

  const events: ScrapedEvent[] = [];
  for (const container of containers) {
    const items = Array.isArray(container) ? container : [container];
    for (const item of items) {
      const eventName: string =
        item.name ?? item.eventName ?? item.EventName ??
        ((item.homeTeamName ?? item.home) && (item.awayTeamName ?? item.away)
          ? `${item.homeTeamName ?? item.home} - ${item.awayTeamName ?? item.away}`
          : "");
      if (!eventName) continue;
      const eventKey = buildEventKey(sport, eventName);
      const markets: any[] = item.markets ?? item.Markets ?? item.betOffers ?? item.Bets ?? [];
      for (const m of markets) {
        const mName: string = (m.name ?? m.Name ?? m.type ?? "").toLowerCase();
        if (!mName.includes("1x2") && !mName.includes("resultado") && !mName.includes("match result") &&
            !mName.includes("winner") && !mName.includes("ganador") && !mName.includes("outright")) continue;
        const sels: any[] = m.selections ?? m.Selections ?? m.outcomes ?? m.Outcomes ?? m.prices ?? [];
        const outcomes: H2HOutcome[] = sels
          .map((s: any) => {
            const rawOdds = s.price ?? s.Price ?? s.decimalPrice ?? s.odds ?? s.Odds ?? s.decimal ?? 0;
            const odds = typeof rawOdds === "string" ? parseFloat(rawOdds) : Number(rawOdds);
            const name: string = s.name ?? s.Name ?? s.type ?? s.label ?? s.runnerName ?? "";
            return odds >= 1.01 && name ? { name, odds } : null;
          })
          .filter(Boolean) as H2HOutcome[];
        if (outcomes.length >= 2) {
          events.push({ bookmaker, sport, eventKey, eventName, isLive, market: "h2h", outcomes });
          break;
        }
      }
    }
  }
  return events;
}

/** Intenta todos los parsers en orden y devuelve el primero que produce resultados */
function tryAllParsers(data: any, bookmaker: string, sport: Sport, isLive: boolean): ScrapedEvent[] {
  for (const fn of [parseAltenar, parseKambi, parseOpenBet]) {
    const results = fn(data, bookmaker, sport, isLive);
    if (results.length > 0) return results;
  }
  return [];
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isBrowserCrash(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("browser has been closed") ||
    msg.includes("target closed") ||
    msg.includes("context or browser has been closed")
  );
}

export class WilliamHillScraper extends BaseScraper {
  readonly name = "williamhill";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  private async scrapePage(url: string, sport: Sport, isLive: boolean, retried = false): Promise<ScrapedEvent[]> {
    let ctx: BrowserContext | null = null;
    const captures: Array<{ url: string; data: any }> = [];
    const allRequestUrls: Array<{ url: string; status: number }> = [];
    const wsFramesWH: string[] = [];
    const events: ScrapedEvent[] = [];
    let browserCrashed = false;

    try {
      const whProxy = getProxyForScraper('williamhill');
      ctx = await browserManager.createContext(whProxy);
      const page = await ctx.newPage();
      // Block media that wastes RAM
      await page.route("**/*", (route: any) => {
        const t: string = route.request().resourceType();
        if (["image", "stylesheet", "font", "media", "other"].includes(t)) return route.abort();
        return route.continue();
      });

      page.on("response", async (res: any) => {
        const u: string = res.url();
        const status: number = res.status();
        if (!u.includes("google-analytics") && !u.includes("hotjar") && !u.startsWith("data:")) {
          allRequestUrls.push({ url: u, status });
        }
        if (status !== 200) return;
        const ct: string = res.headers()?.["content-type"] ?? "";
        if (!ct.includes("json") && !ct.includes("javascript")) return;
        if (u.includes("google-analytics") || u.includes("hotjar") || u.includes("optimizely")) return;
        try {
          const data = await res.json().catch(() => null);
          if (data && JSON.stringify(data).length > 300) captures.push({ url: u, data });
        } catch { /* non-JSON */ }
      });

      // Q-L: capture WebSocket frames from sports.whcdn.net (WH push-based odds delivery)
      page.on("websocket", (ws: any) => {
        const wsUrl: string = ws.url();
        if (!wsUrl.includes("whcdn.net") && !wsUrl.includes("williamhill")) return;
        this.log(`WH WebSocket connected: ${wsUrl.slice(0, 80)}`);
        ws.on("framereceived", (frame: any) => {
          const raw = frame.payload;
          const payload = typeof raw === "string" ? raw :
            Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
          if (payload.length > 20) wsFramesWH.push(payload);
        });
      });

      // Load homepage first so WH establishes a guest session (cookies, CAS token) before betting API calls
      await page.goto("https://www.williamhill.es/", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await dismissCookies(page);
      // Short fixed wait for auth XHR calls and session cookie to settle
      await new Promise<void>((r) => setTimeout(r, 1_500));

      const capturesBefore = captures.length;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 55_000 });
      // Event-driven: exit as soon as first meaningful JSON arrives (max 15s)
      const captureDeadline = Date.now() + 15_000;
      while (captures.length === capturesBefore && Date.now() < captureDeadline) {
        await new Promise<void>((r) => setTimeout(r, 200));
      }
      // Brief grace window to collect simultaneous responses
      if (captures.length > capturesBefore) {
        await new Promise<void>((r) => setTimeout(r, 1_500));
      }

      const finalUrl = page.url();
      const title = await page.title().catch(() => "");

      // Log ALL domains contacted (incl. non-200) to diagnose geo-block
      if (allRequestUrls.length > 0) {
        const blocked = allRequestUrls.filter(r => r.status === 403 || r.status === 401 || r.status === 0);
        const domains = [...new Set(allRequestUrls.map(r => new URL(r.url).hostname))];
        this.log(`WH requests (${allRequestUrls.length} total): domains = ${domains.join(", ")}`);
        if (blocked.length > 0) {
          this.warn(`WH blocked responses (${blocked.length}): ${blocked.map(r => `${r.status} ${r.url.replace(/https?:\/\/[^/]+/, "").slice(0, 50)}`).join(" | ")}`);
        }
      }
      if (captures.length > 0) {
        const domains = [...new Set(captures.map((c) => new URL(c.url).hostname))];
        this.log(`WH JSON captures (${captures.length}): ${domains.join(", ")}`);
        this.log(`URLs: ${captures.map((c) => c.url.replace(/https?:\/\/[^/]+/, "").slice(0, 60)).join(" | ")}`);
      } else {
        this.warn(`WH 0 JSON — URL final: ${finalUrl} | Title: "${title}"`);
      }

      // Intentar parsear cada respuesta capturada
      for (const { url: capUrl, data } of captures) {
        const parsed = tryAllParsers(data, "williamhill", sport, isLive);
        if (parsed.length > 0) {
          this.log(`Parsed ${parsed.length} events from: ${capUrl.replace(/https?:\/\/[^/]+/, "").slice(0, 70)}`);
          events.push(...parsed);
        }
      }

      // Q-L: parse WS frames from sports.whcdn.net if XHR gave nothing
      if (events.length === 0 && wsFramesWH.length > 0) {
        this.log(`WH WS: ${wsFramesWH.length} frames from whcdn.net`);
        for (const payload of wsFramesWH) {
          try {
            const data = JSON.parse(payload);
            const parsed = tryAllParsers(data, "williamhill", sport, isLive);
            if (parsed.length > 0) {
              this.log(`WH WS parsed ${parsed.length} events`);
              events.push(...parsed);
              break;
            }
            // Log keys for diagnosis — helps identify the correct parser
            const topKeys = typeof data === "object" && data !== null
              ? Object.keys(data).slice(0, 8).join(",") : typeof data;
            this.log(`WH WS frame keys: [${topKeys}] sample: ${JSON.stringify(data).slice(0, 200)}`);
            break; // log only first parseable frame
          } catch {
            // Non-JSON or binary frame — log raw sample for protocol diagnosis
            if (wsFramesWH.indexOf(payload) === 0) {
              this.log(`WH WS raw frame[0]: ${payload.slice(0, 200)}`);
            }
          }
        }
      } else if (wsFramesWH.length > 0) {
        this.log(`WH WS: ${wsFramesWH.length} frames captured (whcdn.net)`);
      }

      // DOM fallback si XHR no dio resultados
      if (events.length === 0) {
        const rows = await page.$$(
          "[class*='event-row'], [class*='EventRow'], [data-test='event-card'], " +
          "[class*='sport-event'], li[class*='event'], [class*='live-event'], " +
          "[class*='fixture'], [class*='Fixture'], [class*='Match']",
        );

        for (const row of rows) {
          const nameEls = await row.$$("[class*='participant'], [class*='team'], [class*='event-name'], [class*='EventTitle']");
          let rawName = "";
          if (nameEls.length >= 2) {
            const h = (await nameEls[0].innerText()).trim();
            const a = (await nameEls[nameEls.length - 1].innerText()).trim();
            if (h && a && h !== a) rawName = `${h} - ${a}`;
          }
          if (!rawName) {
            const combined = await row.$("[class*='event-name'], [class*='EventTitle'], [class*='match-name']");
            rawName = (await combined?.innerText() ?? "").trim().replace(/\n+/g, " - ");
          }
          if (!rawName || rawName.length < 3) continue;

          const eventKey = buildEventKey(sport, rawName);
          const oddsEls = await row.$$(
            "button[class*='price'], [class*='odds-val'], [class*='bet-button'], [class*='Price'], [class*='Odds']",
          );
          const outcomes: H2HOutcome[] = [];
          const labels = ["1", "X", "2"];
          for (let i = 0; i < Math.min(oddsEls.length, 3); i++) {
            const txt = await oddsEls[i].innerText();
            const odds = parseOdds(txt);
            if (odds) outcomes.push({ name: labels[i], odds });
          }
          if (outcomes.length >= 2) {
            events.push({ bookmaker: "williamhill", sport, eventKey, eventName: rawName, isLive, market: "h2h", outcomes });
          }
        }
      }

      if (events.length === 0) {
        await logPageState(page, this.name);
        if (captures.length === 0) {
          this.warn("Sin capturas JSON — el SPA puede no haber cargado o la URL es incorrecta");
        } else {
          saveFailedPayload(this.name, sport, "parse_fail", captures.slice(0, 3).map(c => ({ url: c.url, data: c.data })));
          for (const { url: u, data } of captures.slice(0, 5)) {
            const topKeys = typeof data === "object" ? Object.keys(data ?? {}).slice(0, 6).join(",") : typeof data;
            this.warn(`  ${u.slice(0, 70)} → keys: ${topKeys}`);
          }
        }
      } else {
        this.log(`${isLive ? "Live" : "Prematch"} ${sport}: ${events.length} events`);
      }
    } catch (err) {
      if (isBrowserCrash(err) && !retried) {
        this.warn(`Browser crash (${sport}) — reiniciando Chromium (backoff 1500ms)`);
        browserCrashed = true;
      } else {
        this.warn(`${sport} failed`, err);
      }
    } finally {
      if (ctx) {
        await ctx.close().catch(() => {});
      } else {
        browserManager.releaseSemaphore();
      }
    }

    if (browserCrashed) {
      browserManager.recordCrash();
      await browserManager.shutdown();
      await sleep(1500);
      if (browserManager.isCoolingDown()) {
        this.warn(`Browser en cool-down — cancelando reintento para ${sport}`);
        return events;
      }
      return this.scrapePage(url, sport, isLive, true);
    }

    browserManager.recordSuccess();
    return events;
  }

  private async scrapeWithFallback(candidates: string[], sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    for (const url of candidates) {
      const events = await this.scrapePage(url, sport, isLive);
      if (events.length > 0) return events;
    }
    return [];
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      all.push(...(await this.scrapeWithFallback(URL_CANDIDATES[sport]!.live, sport, true)));
    }
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      all.push(...(await this.scrapeWithFallback(URL_CANDIDATES[sport]!.prematch, sport, false)));
    }
    return all;
  }
}
