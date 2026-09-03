/**
 * DaznBet España — Playwright scraper con STOMP/SockJS.
 *
 * DaznBet usa la plataforma EveryMatrix. Los datos de cuotas llegan por:
 *   1. XHR JSON (formatos A/B/C de EveryMatrix)
 *   2. WebSocket SockJS + protocolo STOMP (fuente principal para live)
 *
 * STOMP handshake:
 *   CONNECT -> CONNECTED -> SUBSCRIBE -> MESSAGE (con body JSON de cuotas)
 *
 * SockJS frame format: a["STOMP_FRAME_STRING"] donde el frame termina en \0
 */

import { BaseScraper } from "./base";
import { browserManager, dismissCookies, parseOdds, logPageState, getProxyForScraper, saveFailedPayload } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

// Q-M: use final redirected URLs (avoid 302 overhead; confirmed from PM2 logs)
const URLS: Partial<Record<Sport, { live: string; prematch: string }>> = {
  FOOTBALL: {
    live:     "https://www.daznbet.es/es/sports/futbol?liveMode=true",
    prematch: "https://www.daznbet.es/es/sports/futbol",
  },
  TENNIS: {
    live:     "https://www.daznbet.es/es/sports/tenis?liveMode=true",
    prematch: "https://www.daznbet.es/es/sports/tenis",
  },
  BASKETBALL: {
    live:     "https://www.daznbet.es/es/sports/baloncesto?liveMode=true",
    prematch: "https://www.daznbet.es/es/sports/baloncesto",
  },
  HANDBALL: {
    live:     "https://www.daznbet.es/es/sports/balonmano?liveMode=true",
    prematch: "https://www.daznbet.es/es/sports/balonmano",
  },
  VOLLEYBALL: {
    live:     "https://www.daznbet.es/es/sports/voleibol?liveMode=true",
    prematch: "https://www.daznbet.es/es/sports/voleibol",
  },
  ICEHOCKEY: {
    live:     "https://www.daznbet.es/es/sports/hockey-hielo?liveMode=true",
    prematch: "https://www.daznbet.es/es/sports/hockey-hielo",
  },
  BASEBALL: {
    live:     "https://www.daznbet.es/es/sports/beisbol?liveMode=true",
    prematch: "https://www.daznbet.es/es/sports/beisbol",
  },
  AMERICANFOOTBALL: {
    live:     "https://www.daznbet.es/es/sports/futbol-americano?liveMode=true",
    prematch: "https://www.daznbet.es/es/sports/futbol-americano",
  },
  RUGBYLEAGUE: {
    live:     "https://www.daznbet.es/es/sports/rugby?liveMode=true",
    prematch: "https://www.daznbet.es/es/sports/rugby",
  },
};

// DaznBet/EveryMatrix sport IDs (estimación — se confirman vía logs)
const DAZN_SPORT_IDS: Partial<Record<Sport, number>> = { FOOTBALL: 1, TENNIS: 2, BASKETBALL: 3, HANDBALL: 11, VOLLEYBALL: 13, ICEHOCKEY: 7, BASEBALL: 9, AMERICANFOOTBALL: 6, RUGBYLEAGUE: 12 };

// ─── EveryMatrix XHR parsers ──────────────────────────────────────────────────

function isH2HMarket(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "1x2" || n.includes("resultado") || n.includes("match result") ||
    n.includes("match winner") || n.includes("ganador") || n.includes("winner") ||
    n.includes("full time") || n.includes("ft 1x2")
  );
}

function parseEveryMatrixA(data: any, sport: Sport, isLive: boolean): ScrapedEvent[] {
  const markets: any[] = data?.Markets ?? data?.markets ?? [];
  if (!markets.length) return [];
  const byEvent = new Map<string, { name: string; outcomes: H2HOutcome[] }>();
  for (const m of markets) {
    if (!isH2HMarket(m.MarketName ?? m.marketName ?? m.name ?? "")) continue;
    const eventName: string = m.EventName ?? m.eventName ?? m.Event ?? "";
    if (!eventName) continue;
    const runners: any[] = m.Runners ?? m.runners ?? m.Selections ?? m.selections ?? [];
    const outcomes: H2HOutcome[] = runners
      .filter((r: any) => r.IsActive !== false && r.isActive !== false)
      .map((r: any) => {
        const price = parseFloat(String(r.Price ?? r.price ?? r.Odds ?? r.odds ?? 0));
        const name: string = r.Name ?? r.name ?? r.label ?? "";
        return price >= 1.01 && name ? { name, odds: price } : null;
      })
      .filter(Boolean) as H2HOutcome[];
    if (outcomes.length >= 2) byEvent.set(eventName, { name: eventName, outcomes });
  }
  return [...byEvent.entries()].map(([, ev]) => ({
    bookmaker: "daznbet", sport, eventKey: buildEventKey(sport, ev.name),
    eventName: ev.name, isLive, market: "h2h", outcomes: ev.outcomes,
  }));
}

function parseEveryMatrixB(data: any, sport: Sport, isLive: boolean): ScrapedEvent[] {
  const evList: any[] = data?.data?.events ?? data?.events ?? data?.EventList ?? data?.eventList ?? [];
  if (!evList.length) return [];
  const events: ScrapedEvent[] = [];
  for (const ev of evList) {
    const eventName: string = ev.name ?? ev.Name ?? ev.EventName ?? "";
    if (!eventName) continue;
    const startTime = (ev.startDate ?? ev.StartDate ?? ev.start ?? ev.anticipated?.startTime)
      ? new Date(ev.startDate ?? ev.StartDate ?? ev.start ?? ev.anticipated?.startTime) : undefined;
    const eventKey = buildEventKey(sport, eventName, startTime);
    for (const m of (ev.markets ?? ev.Markets ?? ev.betOffers ?? [])) {
      if (!isH2HMarket(m.name ?? m.Name ?? m.type ?? "")) continue;
      const outs: any[] = m.outcomes ?? m.Outcomes ?? m.selections ?? m.Selections ?? m.runners ?? [];
      const outcomes: H2HOutcome[] = outs.map((o: any) => {
        const price = parseFloat(String(o.price ?? o.Price ?? o.odds ?? o.Odds ?? 0));
        const name: string = o.name ?? o.Name ?? o.label ?? o.Label ?? "";
        return price >= 1.01 && name ? { name, odds: price } : null;
      }).filter(Boolean) as H2HOutcome[];
      if (outcomes.length >= 2) {
        events.push({ bookmaker: "daznbet", sport, eventKey, eventName, startTime, isLive, market: "h2h", outcomes });
        break;
      }
    }
  }
  return events;
}

function parseKambiLike(data: any, sport: Sport, isLive: boolean): ScrapedEvent[] {
  const evList: any[] = data?.liveEvents ?? data?.events ?? [];
  if (!evList.length) return [];
  const events: ScrapedEvent[] = [];
  for (const item of evList) {
    const ev = item.event ?? item;
    const eventName: string = ev.name ?? `${ev.homeName ?? ""} - ${ev.awayName ?? ""}`;
    if (!eventName) continue;
    const eventKey = buildEventKey(sport, eventName);
    for (const offer of (item.betOffers ?? [])) {
      const label = (offer.criterion?.label ?? offer.betOfferType?.name ?? "").toLowerCase();
      if (!isH2HMarket(label)) continue;
      const outcomes: H2HOutcome[] = (offer.outcomes ?? []).map((o: any) => {
        const raw = o.odds ?? o.decimalOdds ?? 0;
        const odds = raw > 100 ? raw / 1000 : Number(raw);
        const name: string = o.label ?? o.type ?? "";
        return odds >= 1.01 && name ? { name, odds } : null;
      }).filter(Boolean) as H2HOutcome[];
      if (outcomes.length >= 2) {
        events.push({ bookmaker: "daznbet", sport, eventKey, eventName, isLive, market: "h2h", outcomes });
        break;
      }
    }
  }
  return events;
}

function parseAny(data: any, sport: Sport, isLive: boolean): ScrapedEvent[] {
  const a = parseEveryMatrixA(data, sport, isLive);
  if (a.length > 0) return a;
  const b = parseEveryMatrixB(data, sport, isLive);
  if (b.length > 0) return b;
  return parseKambiLike(data, sport, isLive);
}

// ─── STOMP / SockJS parser ────────────────────────────────────────────────────

interface StompFrame {
  command: string;
  headers: Record<string, string>;
  body: any;
}

function parseStompSockJS(payload: string): StompFrame[] {
  // SockJS text frames: server sends "a[...]", client sends "[...]"
  const isServer = payload.startsWith("a[");
  if (!isServer && !payload.startsWith("[")) return [];
  try {
    const arr: string[] = JSON.parse(isServer ? payload.slice(1) : payload);
    return arr.flatMap((raw) => {
      // STOMP frames end with \0 (null byte U+0000)
      const nullIdx = raw.indexOf("\u0000");
      const clean = nullIdx >= 0 ? raw.slice(0, nullIdx) : raw;
      const blankLine = clean.indexOf("\n\n");
      const headerPart = blankLine >= 0 ? clean.slice(0, blankLine) : clean;
      const bodyStr = blankLine >= 0 ? clean.slice(blankLine + 2) : "";
      const lines = headerPart.split("\n");
      const command = lines[0].replace(/\r$/, "");
      if (!command) return [];
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon >= 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }
      let body: any = bodyStr;
      if (bodyStr) { try { body = JSON.parse(bodyStr); } catch { /* keep as string */ } }
      return [{ command, headers, body }];
    });
  } catch { return []; }
}

function extractEventIds(body: any): string[] {
  if (typeof body !== "string" || !body.startsWith("H4sI")) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { gunzipSync } = require("zlib");
    const dec = gunzipSync(Buffer.from(body, "base64")).toString("utf8");
    const patches: any[] = JSON.parse(dec);
    for (const patch of patches) {
      const evts = patch?.value?.events;
      if (evts && typeof evts === "object") return Object.keys(evts);
    }
  } catch { /* ignore */ }
  return [];
}

function parseStompMessage(body: any, sport: Sport, isLive: boolean): ScrapedEvent[] {
  if (!body || typeof body !== "object") return [];
  const evList: any[] =
    body?.events ?? body?.data?.events ?? body?.EventList ?? body?.eventList ??
    (Array.isArray(body) ? body : []);
  if (!evList.length) return [];
  const events: ScrapedEvent[] = [];
  for (const ev of evList) {
    const eventName: string = ev.name ?? ev.Name ?? ev.EventName ??
      (ev.homeName && ev.awayName ? `${ev.homeName} - ${ev.awayName}` : "");
    if (!eventName) continue;
    const startTime = (ev.startDate ?? ev.StartDate)
      ? new Date(ev.startDate ?? ev.StartDate) : undefined;
    const eventKey = buildEventKey(sport, eventName, startTime);
    for (const m of (ev.markets ?? ev.Markets ?? ev.betOffers ?? [])) {
      if (!isH2HMarket(m.name ?? m.Name ?? m.type ?? "")) continue;
      const outs: any[] = m.outcomes ?? m.Outcomes ?? m.selections ?? m.runners ?? [];
      const outcomes: H2HOutcome[] = outs.map((o: any) => {
        const price = parseFloat(String(o.price ?? o.Price ?? o.odds ?? o.Odds ?? 0));
        const name: string = o.name ?? o.Name ?? o.label ?? "";
        return price >= 1.01 && name ? { name, odds: price } : null;
      }).filter(Boolean) as H2HOutcome[];
      if (outcomes.length >= 2) {
        events.push({ bookmaker: "daznbet", sport, eventKey, eventName, startTime, isLive, market: "h2h", outcomes });
        break;
      }
    }
  }
  return events;
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

export class DaznBetScraper extends BaseScraper {
  readonly name = "daznbet";
  private _liveRunning = false;
  private _lastLiveResult: ScrapedEvent[] = [];
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "HANDBALL", "VOLLEYBALL", "ICEHOCKEY", "BASEBALL", "AMERICANFOOTBALL", "RUGBYLEAGUE"];

  private async scrapePage(url: string, sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    const { page, ctx } = await browserManager.newPage(getProxyForScraper("daznbet"), undefined, 180_000);
    const allCaptures: Array<{ url: string; data: any }> = [];
    const wsCaptures: Array<{ url: string; payload: string }> = [];
    const wsSentFrames: Array<{ url: string; payload: string }> = [];

    // Q-M: stealth + WebSocket hook — both must run before any page scripts
    await page.addInitScript(`
      (function() {
        // Stealth: remove webdriver flag — DaznBet anti-bot halts STOMP init if navigator.webdriver is true
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        try { delete navigator.__proto__.webdriver; } catch (_) {}

        var _WS = window.WebSocket;
        window.__daznbetWS = null;
        window.__daznbetWSMap = {};
        window.__daznbetHookLog = ['hook_start'];
        function HookedWS(url, protocols) {
          window.__daznbetHookLog.push('ctor:' + String(url).slice(0, 80));
          var ws = protocols ? new _WS(url, protocols) : new _WS(url);
          if (String(url).includes('sb-pp-esfe')) {
            window.__daznbetWS = ws;
            var m = String(url).match(/sb-pp-esfe\.daznbet\.es\/([^/]+)\//);
            if (m) { window.__daznbetWSMap[m[1]] = ws; window.__daznbetHookLog.push('map:' + m[1]); }
          }
          return ws;
        }
        window.__daznbetHookLog.push('hook_installed');
        HookedWS.prototype = _WS.prototype;
        HookedWS.CONNECTING = _WS.CONNECTING;
        HookedWS.OPEN = _WS.OPEN;
        HookedWS.CLOSING = _WS.CLOSING;
        HookedWS.CLOSED = _WS.CLOSED;
        window.WebSocket = HookedWS;
      })();
    `);

    page.on("response", async (res: any) => {
      try {
        if (res.status() !== 200) return;
        const ct: string = res.headers()?.["content-type"] ?? "";
        if (!ct.includes("json")) return;
        const u: string = res.url();
        if (u.includes("analytics") || u.includes("hotjar") || u.includes("google-tag")) return;
        const data = await res.json().catch(() => null);
        if (data && JSON.stringify(data).length > 300) allCaptures.push({ url: u, data });
      } catch { /* closed / non-JSON */ }
    });

    // Capturar frames recibidos (server→browser) Y enviados (browser→server)
    page.on("websocket", (ws: any) => {
      const wsUrl: string = ws.url();
      ws.on("framereceived", (frame: any) => {
        const raw = frame.payload;
        const payload = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
        if (payload.length > 10) wsCaptures.push({ url: wsUrl, payload });
      });
      ws.on("framesent", (frame: any) => {
        const raw = frame.payload;
        const payload = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
        if (payload.length > 5) wsSentFrames.push({ url: wsUrl, payload });
      });
    });

    const blockedResponses: Array<{ status: number; url: string }> = [];
    page.on("response", (res: any) => {
      const status: number = res.status();
      const u: string = res.url();
      if (status !== 200 && status >= 400 && !u.includes("analytics") && !u.includes("hotjar")) {
        blockedResponses.push({ status, url: u });
      }
    });

    const events: ScrapedEvent[] = [];
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 55_000 });
      await page.waitForTimeout(5_000);
      await dismissCookies(page);
      // Esperar a que el SPA cargue y el WS se establezca antes de inyectar
      await page.waitForTimeout(15_000);

      // Debug: read the WS hook log
      const hookLog = await page.evaluate(() => (window as any).__daznbetHookLog ?? []);
      this.log(`WS hook log: ${JSON.stringify(hookLog).slice(0, 400)}`);

      // Phase 0: Subscribe to eventmaplivedocl1 ourselves to get the full event list.
      // The SPA only subscribes to eventmap/socketConnection (handshake) within our capture window;
      // the actual eventmap/upcoming{CODE} subscription push — which contains all event IDs — arrives
      // later after a lazy component mounts. We subscribe directly to get it immediately.
      const EVTMAP_CODES: Partial<Record<string, string>> = { FOOTBALL: "FBL", BASKETBALL: "BKB", TENNIS: "TNS", HANDBALL: "HBL", VOLLEYBALL: "VLB", ICEHOCKEY: "HKY", BASEBALL: "BSB", AMERICANFOOTBALL: "AFB", RUGBYLEAGUE: "RUG" };
      const evtmapSportCode = EVTMAP_CODES[sport] ?? "FBL";
      const evtmapServerId = String(Math.floor(Math.random() * 900 + 100));
      const evtmapSessId = Math.random().toString(36).substring(2, 10);
      const evtmapWsUrl = `wss://sb-pp-esfe.daznbet.es/eventmaplivedocl1/livedoc/${evtmapServerId}/${evtmapSessId}/websocket`;
      this.log(`Eventmap WS: ${evtmapWsUrl} → eventmap/upcoming${evtmapSportCode}`);
      const evtmapResult = await page.evaluate(
        async ({ wsUrl, sportCode }: { wsUrl: string; sportCode: string }) => {
          try {
            const ws = new window.WebSocket(wsUrl);
            const NUL = "\u0000";
            const msgs: string[] = [];
            ws.onmessage = (e: any) => { msgs.push(String(e.data)); };
            await new Promise<void>((resolve, reject) => {
              ws.onopen = () => resolve();
              ws.onerror = () => reject(new Error("ws_open_error"));
              setTimeout(() => reject(new Error("ws_open_timeout")), 15000);
            });
            ws.send(JSON.stringify([`CONNECT\naccept-version:1.1,1.0\nheart-beat:10000,10000\n\n${NUL}`]));
            await new Promise<void>((resolve) => {
              const check = setInterval(() => {
                if (msgs.some(m => m.includes("CONNECTED"))) { clearInterval(check); resolve(); }
              }, 100);
              setTimeout(() => { clearInterval(check); resolve(); }, 4000);
            });
            ws.send(JSON.stringify([`SUBSCRIBE\nX-Lang:es\nsendEmpty:true\nid:sub-em-0\ndestination:eventmap/socketConnection\n\n${NUL}`]));
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 1500));
            ws.send(JSON.stringify([`SUBSCRIBE\nX-Lang:es\nsendEmpty:true\nid:sub-em-1\ndestination:eventmap/upcoming${sportCode}\n\n${NUL}`]));
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 4000));
            ws.close();
            return { ok: true, msgs, error: "" };
          } catch (err) {
            return { ok: false, msgs: [] as string[], error: String(err) };
          }
        },
        { wsUrl: evtmapWsUrl, sportCode: evtmapSportCode },
      );
      this.log(`Eventmap WS: ${evtmapResult.msgs.length} msgs ok=${evtmapResult.ok} err=${evtmapResult.error}`);
      for (const m of evtmapResult.msgs) {
        this.log(`Eventmap msg: ${m.slice(0, 500)}`);
        wsCaptures.push({ url: evtmapWsUrl, payload: m });
      }

      // Phase 1a: extract event IDs from gzip eventmap bodies already received
      const eventIds: string[] = [];
      for (const { payload } of wsCaptures) {
        for (const frame of parseStompSockJS(payload)) {
          if (frame.command === "MESSAGE") {
            const ids = extractEventIds(frame.body);
            if (ids.length > 0) eventIds.push(...ids);
          }
        }
      }
      // Phase 1b: extract event IDs from SPA's own events/* SUBSCRIBE topics (live events)
      const sentEventIds = wsSentFrames
        .flatMap(f => parseStompSockJS(f.payload))
        .filter(f => f.command === "SUBSCRIBE")
        .map(f => f.headers.destination ?? "")
        .filter(d => /^events\/[A-Z]+-\d+$/.test(d))
        .map(d => d.replace("events/", ""));
      for (const id of sentEventIds) {
        if (!eventIds.includes(id)) eventIds.push(id);
      }
      // Phase 1c: extract event IDs from plain JSON eventmap bodies (value.events dict keys)
      for (const { payload } of wsCaptures) {
        for (const frame of parseStompSockJS(payload)) {
          if (frame.command !== "MESSAGE") continue;
          const dest: string = (frame.headers as any)?.destination ?? "";
          if (!dest.startsWith("eventmap/")) continue;
          try {
            const patches = Array.isArray(frame.body) ? frame.body : JSON.parse(String(frame.body));
            if (Array.isArray(patches)) {
              for (const patch of patches) {
                if (patch?.value?.events) {
                  for (const id of Object.keys(patch.value.events)) {
                    if (!eventIds.includes(id)) eventIds.push(id);
                  }
                }
              }
            }
          } catch { /* not JSON */ }
        }
      }
      this.log(`DaznBet eventmap IDs: ${eventIds.length} events (gzip+sent, first 5: ${eventIds.slice(0, 5).join(", ")})`);

      // Phase 2: create NEW WebSocket to eventlivedocl1 and subscribe to events/{id}
      // eventlivedocl1 handles individual event data including markets/odds
      // SPA flow: subscribe events/socketConnection (handshake) → subscribe events/{id}
      const topN = isLive ? eventIds.slice(0, 20) : eventIds.slice(0, 150);
      const evtCapUrl = [...new Set(wsCaptures.map(w => w.url))].find(u => u.includes("eventlivedocl1"));
      const evtSvrMatch = evtCapUrl?.match(/eventlivedocl1\/livedoc\/(\d+)\//);
      const evtServerId = evtSvrMatch ? evtSvrMatch[1] : String(Math.floor(Math.random() * 900 + 100));
      const evtSessId = Math.random().toString(36).substring(2, 10);
      const evtWsUrl = `wss://sb-pp-esfe.daznbet.es/eventlivedocl1/livedoc/${evtServerId}/${evtSessId}/websocket`;
      this.log(`Event WS: ${evtWsUrl} (${topN.length} ids)`);
      const marketResult = await page.evaluate(
        async ({ wsUrl, ids }: { wsUrl: string; ids: string[] }) => {
          try {
            const ws = new window.WebSocket(wsUrl);
            const NUL = "\u0000";
            const msgs: string[] = [];
            ws.onmessage = (e: any) => { msgs.push(String(e.data)); };
            await new Promise<void>((resolve, reject) => {
              ws.onopen = () => resolve();
              ws.onerror = () => reject(new Error("ws_open_error"));
              setTimeout(() => reject(new Error("ws_open_timeout")), 12000);
            });
            ws.send(JSON.stringify([`CONNECT\naccept-version:1.1,1.0\nheart-beat:10000,10000\n\n${NUL}`]));
            await new Promise<void>((resolve) => {
              const check = setInterval(() => {
                if (msgs.some(m => m.includes("CONNECTED"))) { clearInterval(check); resolve(); }
              }, 100);
              setTimeout(() => { clearInterval(check); resolve(); }, 4000);
            });
            // Handshake: subscribe to events/socketConnection first
            ws.send(JSON.stringify([`SUBSCRIBE\nX-Lang:es\nsendEmpty:true\nid:sub-0\ndestination:events/socketConnection\n\n${NUL}`]));
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000));
            // Subscribe to individual event IDs to get event data with odds
            ids.forEach((id: string, i: number) => {
              ws.send(JSON.stringify([`SUBSCRIBE\nX-Lang:es\nsendEmpty:true\nid:sub-${i + 1}\ndestination:events/${id}\n\n${NUL}`]));
            });
            // Collect event data for 12 seconds
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 7000));
            ws.close();
            return { ok: true, msgs, error: "" };
          } catch (err) {
            return { ok: false, msgs: [] as string[], error: String(err) };
          }
        },
        { wsUrl: evtWsUrl, ids: topN },
      );
      if (!marketResult.ok) {
        this.warn(`Event WS error: ${marketResult.error}`);
      } else {
        this.log(`Event WS: ${marketResult.msgs.length} msgs from ${topN.length} events`);
        for (const m of marketResult.msgs) {
          this.log(`Event msg: ${m.slice(0, 600)}`);
        }
      }
      for (const m of marketResult.msgs) {
        wsCaptures.push({ url: evtWsUrl, payload: m });
      }

      // Extract startTimes from events/{id} frames (now in wsCaptures after Phase 2)
      const eventStartTimes = new Map<string, Date>();
      for (const { payload: stPayload } of wsCaptures) {
        for (const stFrame of parseStompSockJS(stPayload)) {
          if (stFrame.command !== "MESSAGE") continue;
          const stDest: string = (stFrame.headers as any)?.destination ?? "";
          if (!stDest.startsWith("events/") || stDest === "events/socketConnection") continue;
          try {
            const stPatches = Array.isArray(stFrame.body) ? stFrame.body : JSON.parse(String(stFrame.body));
            if (!Array.isArray(stPatches)) continue;
            for (const stPatch of stPatches) {
              const stEv = stPatch?.value;
              if (stEv?.id && stEv?.anticipated?.startTime) {
                const st = new Date(String(stEv.anticipated.startTime));
                if (!isNaN(st.getTime()) && st.getFullYear() > 2020) {
                  eventStartTimes.set(String(stEv.id), st);
                }
              }
            }
          } catch { /* skip */ }
        }
      }
      this.log(`DaznBet startTimes from events: ${eventStartTimes.size}`);

      // Phase 2.5: subscribe to MAIN market IDs (h2h winner) from miniCoupons
      // Extract market IDs from events/{id} STOMP bodies → subscribe on marketlivedocl1
      const MARKET_H2H_KEYS: Partial<Record<string, string[]>> = {
        FOOTBALL: ["MAIN", "WIN+TOTR2", "TOTR3"],
        TENNIS: ["MAIN", "MWIN", "TOTR2"],
        BASKETBALL: ["TOTR2", "MAIN", "MWIN"],
        HANDBALL: ["WIN", "MAIN", "TWINNER"],
        VOLLEYBALL: ["WIN", "1S+WIN", "MAIN"],
        ICEHOCKEY: ["WIN", "MAIN", "WIN+TOTR2", "3WIN"],
        BASEBALL: ["WIN", "MAIN"],
        AMERICANFOOTBALL: ["WIN", "MAIN", "WIN+TOTR2"],
        RUGBYLEAGUE: ["WIN", "MAIN"],
      };
      const h2hKeys = MARKET_H2H_KEYS[sport] ?? ["MAIN"];
      const mktIdsToSub: Array<{ eventId: string; eventName: string; marketId: string }> = [];
      for (const { payload: capPayload } of wsCaptures) {
        for (const frame of parseStompSockJS(capPayload)) {
          if (frame.command !== "MESSAGE") continue;
          const dest25: string = (frame.headers as any)?.destination ?? "";
          if (!dest25.startsWith("events/") || dest25 === "events/socketConnection") continue;
          try {
            const patches25 = Array.isArray(frame.body) ? frame.body : JSON.parse(String(frame.body));
            if (!Array.isArray(patches25)) continue;
            for (const patch25 of patches25) {
              const ev25 = patch25?.value;
              if (!ev25?.miniCoupons) continue;
              const mc25 = ev25.miniCoupons as Record<string, string[]>;
              for (const key25 of h2hKeys) {
                const mids25 = mc25[key25];
                if (mids25 && mids25.length > 0) {
                  if (!mktIdsToSub.find(x => x.eventId === ev25.id)) {
                    mktIdsToSub.push({ eventId: ev25.id, eventName: ev25.name ?? "", marketId: mids25[0] });
                  }
                  break;
                }
              }
            }
          } catch { /* not JSON */ }
        }
      }
      const topMkts = isLive ? mktIdsToSub.slice(0, 20) : mktIdsToSub.slice(0, 150);
      this.log(`Market sub: ${topMkts.length} markets (keys=${h2hKeys.join(",")}): ${topMkts.map(m => m.marketId).join(", ")}`);

      if (topMkts.length > 0) {
        const mkt25SvrId = String(Math.floor(Math.random() * 900 + 100));
        const mkt25SessId = Math.random().toString(36).substring(2, 10);
        const mkt25WsUrl = `wss://sb-pp-esfe.daznbet.es/marketlivedocl1/livedoc/${mkt25SvrId}/${mkt25SessId}/websocket`;
        this.log(`Market WS 2.5: ${mkt25WsUrl}`);
        const mkt25Result = await page.evaluate(
          async ({ wsUrl, marketIds }: { wsUrl: string; marketIds: string[] }) => {
            try {
              const ws = new window.WebSocket(wsUrl);
              const NUL = "\u0000";
              const msgs: string[] = [];
              ws.onmessage = (e: any) => { msgs.push(String(e.data)); };
              await new Promise<void>((resolve, reject) => {
                ws.onopen = () => resolve();
                ws.onerror = () => reject(new Error("ws_open_error"));
                setTimeout(() => reject(new Error("ws_open_timeout")), 12000);
              });
              ws.send(JSON.stringify([`CONNECT\naccept-version:1.1,1.0\nheart-beat:10000,10000\n\n${NUL}`]));
              await new Promise<void>((resolve) => {
                const check = setInterval(() => {
                  if (msgs.some(m => m.includes("CONNECTED"))) { clearInterval(check); resolve(); }
                }, 100);
                setTimeout(() => { clearInterval(check); resolve(); }, 4000);
              });
              ws.send(JSON.stringify([`SUBSCRIBE\nX-Lang:es\nsendEmpty:true\nid:sub-mkt25-0\ndestination:markets/socketConnection\n\n${NUL}`]));
              await new Promise<void>((resolve) => setTimeout(() => resolve(), 1500));
              marketIds.forEach((mid: string, i: number) => {
                ws.send(JSON.stringify([`SUBSCRIBE\nX-Lang:es\nsendEmpty:true\nid:sub-mkt25-${i + 1}\ndestination:markets/${mid}\n\n${NUL}`]));
              });
              await new Promise<void>((resolve) => setTimeout(() => resolve(), 5000));
              ws.close();
              return { ok: true, msgs, error: "" };
            } catch (err) {
              return { ok: false, msgs: [] as string[], error: String(err) };
            }
          },
          { wsUrl: mkt25WsUrl, marketIds: topMkts.map(m => m.marketId) },
        );
        this.log(`Market WS 2.5: ${mkt25Result.msgs.length} msgs ok=${mkt25Result.ok} err=${mkt25Result.error}`);
        for (const m of mkt25Result.msgs) {
          this.log(`Mkt25 msg: ${m.slice(0, 800)}`);
        }
        for (const m of mkt25Result.msgs) {
          wsCaptures.push({ url: mkt25WsUrl, payload: m });
        }

        // Parse market odds into ScrapedEvent objects
        for (const rawMsg of mkt25Result.msgs) {
          for (const frame of parseStompSockJS(rawMsg)) {
            if (frame.command !== "MESSAGE") continue;
            const mktDest: string = (frame.headers as any)?.destination ?? "";
            if (!mktDest.startsWith("markets/") || mktDest === "markets/socketConnection") continue;
            try {
              const mktPatches = Array.isArray(frame.body) ? frame.body : JSON.parse(String(frame.body));
              if (!Array.isArray(mktPatches)) continue;
              for (const mp of mktPatches) {
                const mkt = mp?.value;
                if (!mkt?.selections || !Array.isArray(mkt.selections[0])) continue;
                const sels: any[] = mkt.selections[0];
                const outcomes: H2HOutcome[] = sels
                  .map((s: any) => {
                    const dec = parseFloat(s?.price?.dec ?? "0");
                    return isFinite(dec) && dec > 1.0 ? { name: s.name ?? "", odds: dec } : null;
                  })
                  .filter((x: any): x is H2HOutcome => x !== null);
                if (outcomes.length < 2) continue;
                // Match eventName from mktIdsToSub
                const mktEntry = topMkts.find((m) => m.marketId === mkt.id);
                const eventName = mktEntry?.eventName ?? outcomes.map((o) => o.name).join(" v ");
                const startTime = mkt.betting?.startTime
                  ? new Date(mkt.betting.startTime)
                  : (mkt.eventId ? eventStartTimes.get(String(mkt.eventId)) : undefined);
                const eventKey = buildEventKey(sport as Sport, eventName, startTime);
                events.push({
                  bookmaker: "daznbet",
                  sport: sport as any,
                  eventKey,
                  eventName,
                  isLive,
                  market: "h2h",
                  outcomes,
                  ...(startTime ? { startTime } : {}),
                });
              }
            } catch { /* skip */ }
          }
        }
        this.log(`DaznBet market parse: ${events.length} events from Phase 2.5`);
      }
      // ── Parsear XHR JSON
      for (const { url: capUrl, data } of allCaptures) {
        const parsed = parseAny(data, sport, isLive);
        if (parsed.length > 0) {
          this.log(`XHR parsed ${parsed.length} events from: ${capUrl.replace(/https?:\/\/[^/]+/, "").slice(0, 70)}`);
          events.push(...parsed);
        }
      }

      // ── Parsear frames STOMP recibidos
      let stompEvents = 0;
      for (const { payload } of wsCaptures) {
        const frames = parseStompSockJS(payload);
        for (const frame of frames) {
          if (frame.command === "MESSAGE") {
            const _bodyStr = typeof frame.body === "object" ? JSON.stringify(frame.body).slice(0, 600) : String(frame.body).slice(0, 600);
            this.log(`STOMP MSG body type=${typeof frame.body} dest=${frame.headers.destination ?? "?"} sample=${_bodyStr}`);
            // Dump full gzip bodies for inspection
            if (typeof frame.body === "string" && (frame.body as string).startsWith("H4sI")) {
              const _dest = (frame.headers.destination ?? "unknown").replace(/\//g, "_");
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const _fsp = require("fs");
              _fsp.writeFileSync(`/tmp/daznbet_${_dest}.b64`, frame.body as string);
            }
            const parsed = parseStompMessage(frame.body, sport, isLive);
            if (parsed.length > 0) {
              this.log(`STOMP MESSAGE: ${parsed.length} events (dest=${frame.headers.destination ?? "?"})`);
              events.push(...parsed);
              stompEvents += parsed.length;
            }
          }
        }
      }

      // ── Log diagnóstico si 0 eventos
      if (events.length === 0) {
        // Mostrar los SUBSCRIBE que envió la página (para conocer los topics reales)
        const sentSubscribes = wsSentFrames
          .flatMap(f => parseStompSockJS(f.payload))
          .filter(f => f.command === "SUBSCRIBE")
          .map(f => f.headers.destination ?? "?");
        const rawSent = wsSentFrames.slice(0, 5).map(f => f.payload.slice(0, 120));
        if (rawSent.length > 0) this.log(`DaznBet raw sent[0..4]: ${JSON.stringify(rawSent)}`);
        if (sentSubscribes.length > 0) {
          this.log(`DaznBet page SUBSCRIBE topics: ${sentSubscribes.join(" | ")}`);
        }
        // Mostrar todos los comandos STOMP recibidos
        const receivedCmds = wsCaptures
          .flatMap(f => parseStompSockJS(f.payload))
          .map(f => f.command)
          .filter(Boolean);
        if (receivedCmds.length > 0) {
          this.log(`STOMP received commands: ${receivedCmds.join(", ")}`);
        }
        if (wsCaptures.length > 0) {
          const wsUrls = [...new Set(wsCaptures.map(w => w.url.slice(0, 80)))];
          this.warn(`DaznBet WS: ${wsCaptures.length} recv / ${wsSentFrames.length} sent — ${wsUrls.join(" | ")}`);
          const firstA = wsCaptures.find(f => f.payload.startsWith("a["));
          if (firstA) this.warn(`  WS sample: ${firstA.payload.slice(0, 400)}`);
          for (const _w of wsCaptures) {
            for (const _f of parseStompSockJS(_w.payload)) {
              if (_f.command === "MESSAGE" && _f.body) {
                const _k = typeof _f.body === "object" ? Object.keys(_f.body).join(",") : "str";
                const _s = JSON.stringify(_f.body).slice(0, 800);
                this.warn("  MSG keys=[" + _k + "] sample=" + _s);
                break;
              }
            }
            break;
          }
        } else {
          this.warn("DaznBet WS: 0 frames — no WebSocket connection");
        }
        if (allCaptures.length > 0) {
          saveFailedPayload(this.name, sport, "parse_fail", allCaptures.slice(0, 3).map(c => ({ url: c.url, data: c.data })));
          const domains = [...new Set(allCaptures.map((c) => new URL(c.url).hostname))];
          this.warn(`Sin eventos. Dominios JSON: ${domains.join(", ")}`);
          for (const { url: u, data } of allCaptures.slice(0, 5)) {
            const topKeys = typeof data === "object" ? Object.keys(data ?? {}).slice(0, 5).join(",") : "?";
            this.warn(`  ${u.replace(/https?:\/\/[^/]+/, "").slice(0, 70)} → keys: ${topKeys}`);
          }
        } else {
          const finalUrl = page.url();
          const title = await page.title().catch(() => "");
          this.warn(`Sin capturas JSON — URL: ${finalUrl} | Title: "${title}"`);
        }
        if (blockedResponses.length > 0) {
          this.warn(`DaznBet blocked: ${blockedResponses.slice(0, 5).map(r => `${r.status} ${r.url.replace(/https?:\/\/[^/]+/, "").slice(0, 50)}`).join(" | ")}`);
        }
        await logPageState(page, this.name);
      } else {
        this.log(`${isLive ? "Live" : "Prematch"} ${sport}: ${events.length} events (${stompEvents} STOMP, ${events.length - stompEvents} XHR)`);
      }
    } catch (err) {
      this.warn(`${sport} failed`, err);
    } finally {
      await ctx.close();
    }
    return events;
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    if (!getProxyForScraper("daznbet")) { this.log("Sin DAZNBET_PROXY_URL — necesita proxy ES"); return []; }
    // Lock prevents overlapping LIVE cycles from running concurrent scrapeLive calls.
    if (this._liveRunning) { this.log("live locked: returning cached result"); return this._lastLiveResult; }
    this._liveRunning = true;
    try {
      // All sports sequential to avoid overwhelming Chrome with 3 concurrent contexts.
      // FOOTBALL + TENNIS + BASKETBALL are done one at a time; total ~150s < 220s timeout.
      const ftResults: ScrapedEvent[][] = [];
      for (const s of ["FOOTBALL", "TENNIS"]) {
        const r = await this.scrapePage(URLS[s as Sport]!.live, s as Sport, true).catch(() => [] as ScrapedEvent[]);
        ftResults.push(r);
      }
      const bkResults = await this.scrapePage(URLS.BASKETBALL!.live, "BASKETBALL", true).catch(() => [] as ScrapedEvent[]);
      this._lastLiveResult = [...ftResults.flat(), ...bkResults];
      return this._lastLiveResult;
    } finally {
      this._liveRunning = false;
    }
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (!getProxyForScraper("daznbet")) { this.log("Sin DAZNBET_PROXY_URL — necesita proxy ES"); return []; }
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) all.push(...(await this.scrapePage(URLS[sport]!.prematch, sport, false)));
    return all;
  }
}
