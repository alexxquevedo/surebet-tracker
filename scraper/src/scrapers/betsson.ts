/**
 * Betsson France — SSB platform scraper.
 *
 * Architecture:
 *   1. XHR content/get: event metadata (teams, sport code, is4inrunning)
 *   2. WS notification: market price updates (market type messages)
 *   3. DOM fallback: rendered odds as last resort
 *
 * Key insight: betsson uses sport codes TNS (Tennis), FBL (Football), BKB (Basketball)
 * in the XHR idfosporttype field. WS market messages contain pricetypes with selections.
 */

import { BaseScraper } from "./base";
import { browserManager, dismissCookies, parseOdds, getProxyForScraper, setScraperCooldown, isScraperInCooldown } from "./playwright-base";
import type { BrowserContext } from "playwright";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

const URLS: Partial<Record<Sport, { live: string; prematch: string }>> = {
  FOOTBALL: {
    live: "https://www.betsson.fr/fr/sport/en-direct/football",
    prematch: "https://www.betsson.fr/fr/paris-sportifs/football",
  },
  TENNIS: {
    live: "https://www.betsson.fr/fr/sport/en-direct/tennis",
    prematch: "https://www.betsson.fr/fr/paris-sportifs/tennis",
  },
  BASKETBALL: {
    live: "https://www.betsson.fr/fr/sport/en-direct/basketball",
    prematch: "https://www.betsson.fr/fr/paris-sportifs/basketball",
  },
};

// Betsson SSB sport codes from idfosporttype field
const SPORT_CODES: Partial<Record<Sport, string[]>> = {
  FOOTBALL: ["FBL", "FB", "football", "futbol"],
  TENNIS: ["TNS", "TEN", "tennis"],
  BASKETBALL: ["BKB", "basketball"],
};

interface XhrEvent {
  eventId: string;
  home: string;
  away: string;
  sportType: string;
  isLive: boolean;
  marketIds: string[];
}

interface WsMarket {
  marketId: string;
  eventId: string;
  marketName: string;
  selections: Array<{ name: string; odds: number }>;
}

interface BetssonState {
  events: Map<string, XhrEvent>;           // eventId → event
  wsMarkets: Map<string, WsMarket>;        // marketId → market with odds
  marketGroupEvents: Map<string, string[]>; // mgId → eventIds
}

/** Parse Kambi offering API format — { events: [{ event:{...}, betOffers:[...] }] } */
function parseKambiEvents(data: any, sport: Sport, isLive: boolean): ScrapedEvent[] {
  const kambiItems: any[] = data?.events ?? [];
  if (!Array.isArray(kambiItems) || kambiItems.length === 0) return [];
  const first = kambiItems[0];
  if (!first?.event?.id || !Array.isArray(first?.betOffers)) return [];

  const KAMBI_SPORT: Record<string, Sport> = {
    FOOTBALL: "FOOTBALL", SOCCER: "FOOTBALL",
    TENNIS: "TENNIS",
    BASKETBALL: "BASKETBALL", BASKET: "BASKETBALL",
  };

  const events: ScrapedEvent[] = [];
  for (const item of kambiItems) {
    const ev = item.event;
    if (!ev) continue;
    const evSport = String(ev.sport ?? "").toUpperCase();
    if (KAMBI_SPORT[evSport] !== sport) continue;
    const state: string = String(ev.state ?? "").toUpperCase();
    if (isLive && state !== "STARTED") continue;
    if (!isLive && state !== "NOT_STARTED") continue;

    const parts: any[] = ev.participants ?? [];
    const home = parts.find((p: any) => p.type === "home")?.name ?? parts[0]?.name ?? "";
    const away = parts.find((p: any) => p.type === "away")?.name ?? parts[1]?.name ?? "";
    const eventName: string = ev.englishName ?? (home && away ? `${home} - ${away}` : "");
    if (!eventName) continue;

    const offers: any[] = item.betOffers ?? [];
    const main = offers.find((o: any) => o.main === true)
      ?? offers.find((o: any) => (o.outcomes?.length ?? 0) >= 2 && (o.outcomes?.length ?? 0) <= 3);
    if (!main) continue;

    const h2h: H2HOutcome[] = (main.outcomes ?? []).map((o: any) => {
      // Kambi odds are in thousandths (17000 = 1.70)
      const odds = typeof o.odds === "number" ? o.odds / 1000 : parseFloat(String(o.odds ?? "0")) / 1000;
      const name: string = o.englishLabel ?? o.label ?? String(o.type ?? "");
      return odds >= 1.01 && name ? { name, odds } : null;
    }).filter(Boolean) as H2HOutcome[];

    if (h2h.length >= 2) {
      const eventKey = buildEventKey(sport, eventName, ev.start ? new Date(ev.start) : undefined);
      events.push({ bookmaker: "betsson", sport, eventKey, eventName, isLive, market: "h2h", outcomes: h2h });
    }
  }
  return events;
}

function parseXhrEvents(xhrCaptures: Array<{ url: string; data: any }>): XhrEvent[] {
  const events: XhrEvent[] = [];
  const seen = new Set<string>();

  for (const { data } of xhrCaptures) {
    // Format A: { data: { idfoevent, participantname_home, markets } }
    const candidates: any[] = [];
    if (data?.data?.idfoevent) {
      candidates.push(data.data);
    }
    // Format B: { data: [ { idfoevent, ... }, ... ] }
    if (Array.isArray(data?.data)) {
      candidates.push(...data.data.filter((d: any) => d?.idfoevent));
    }
    // Format C: { events: [...] } or { items: [...] }
    const arr = data?.events ?? data?.items ?? data?.results ?? [];
    if (Array.isArray(arr)) {
      candidates.push(...arr.filter((d: any) => d?.idfoevent));
    }
    // Format D: root level array
    if (Array.isArray(data)) {
      candidates.push(...data.filter((d: any) => d?.idfoevent));
    }

    for (const d of candidates) {
      const eid: string = String(d.idfoevent ?? "");
      if (!eid || seen.has(eid)) continue;
      seen.add(eid);

      const home: string = d.participantname_home ?? d.homeName ?? d.home ?? "";
      const away: string = d.participantname_away ?? d.awayName ?? d.away ?? "";
      if (!home && !away) continue;

      const marketIds: string[] = [];
      for (const m of (d.markets ?? [])) {
        const mid = m.idfomarket ?? m.id ?? "";
        if (mid) marketIds.push(String(mid));
      }

      // is4inrunning can be on the event or on markets
      const isLiveEvent: boolean =
        d.is4inrunning === true ||
        d.isinplay === true ||
        (d.markets ?? []).some((m: any) => m.is4inrunning === true);

      events.push({
        eventId: eid,
        home,
        away,
        sportType: String(d.idfosporttype ?? d.sporttypename ?? ""),
        isLive: isLiveEvent,
        marketIds,
      });
    }
  }

  return events;
}

function parseWsMarkets(wsMessages: Array<{ payload: any }>): {
  state: BetssonState;
  typeCounts: Record<string, number>;
  marketSample: string;
} {
  const state: BetssonState = {
    events: new Map(),
    wsMarkets: new Map(),
    marketGroupEvents: new Map(),
  };
  const typeCounts: Record<string, number> = {};
  let marketSample = "";

  for (const { payload } of wsMessages) {
    if (!payload?.data || !Array.isArray(payload.data)) continue;

    for (const item of payload.data) {
      const { contentId, change } = item ?? {};
      if (!contentId?.type || !change) continue;
      const type: string = contentId.type;
      const id: string = String(contentId.id ?? "");

      typeCounts[type] = (typeCounts[type] ?? 0) + 1;

      // Capture the first full market message for diagnostics
      if (type === "market" && !marketSample) {
        marketSample = JSON.stringify(item);
      }

      if (type === "eventGroup" && Array.isArray(change.events)) {
        const mgId: string = String(change.idfwmarketgroup ?? id);
        for (const ev of change.events) {
          if (!ev.idfoevent) continue;
          const eid = String(ev.idfoevent);
          const home: string = ev.participantname_home ?? ev.homeTeam ?? "";
          const away: string = ev.participantname_away ?? ev.awayTeam ?? "";
          const sportType: string = String(ev.idfosporttype ?? ev.sporttypename ?? "");
          const isLive: boolean = ev.isinplay === true || ev.status === "LIVE";

          if (home || away) {
            state.events.set(eid, { eventId: eid, home, away, sportType, isLive, marketIds: [] });
            const existing = state.marketGroupEvents.get(mgId) ?? [];
            if (!existing.includes(eid)) existing.push(eid);
            state.marketGroupEvents.set(mgId, existing);
          }
        }
      }

      if (type === "market") {
        const marketId = id;
        const eventId: string = String(change.idfoevent ?? "");
        const marketName: string = String(change.name ?? change.marketname ?? "");

        // Betsson SSB: odds are in change.selections[], NOT inside pricetypes[].selections
        // Format: fractional odds via currentpriceup/currentpricedown (British format)
        // Decimal = (currentpriceup / currentpricedown) + 1
        const isHeadMarket: boolean = change.isheadmarket === true || change.ismainline === true;
        const directSels: any[] = change.selections ?? [];
        const selections: Array<{ name: string; odds: number }> = [];

        for (const sel of directSels) {
          const nameRaw = String(sel.name ?? sel.shortname ?? sel.selectionname ?? "");
          if (!nameRaw) continue;

          let odds = 0;
          const up = parseFloat(String(sel.currentpriceup ?? "0"));
          const dn = parseFloat(String(sel.currentpricedown ?? "0"));
          if (up > 0 && dn > 0) {
            odds = up / dn + 1; // fractional → decimal
          } else {
            // Fallback: try decimal fields
            const p = sel.price ?? sel.decimal ?? sel.odds ?? 0;
            odds = typeof p === "string" ? parseFloat(p) : Number(p);
          }

          if (odds >= 1.01 && odds <= 1000) {
            selections.push({ name: nameRaw, odds });
          }
        }

        // Save only h2h/winner markets: 2-3 selections AND head market flag
        // (football 1X2=3, tennis/basketball winner=2; goalscorer/correct-score have 10+)
        if (selections.length >= 2 && selections.length <= 3 && isHeadMarket) {
          state.wsMarkets.set(marketId, { marketId, eventId, marketName, selections });
        }
      }
    }
  }

  return { state, typeCounts, marketSample };
}

/** DOM-based price extraction using XHR event data for filtering */
async function domExtract(
  page: any,
  sport: Sport,
  isLive: boolean,
  xhrEvents: XhrEvent[],
): Promise<ScrapedEvent[]> {
  // Build lookup of XHR team names (normalized) for filtering
  const xhrNameTokens = new Set<string>();
  const xhrEventPairs: Array<{ home: string; away: string; isLive: boolean; eventId: string }> = [];

  for (const ev of xhrEvents) {
    if (!ev.home && !ev.away) continue;
    const addTokens = (name: string) => {
      name.toLowerCase().split(/[\s,.-]+/).filter(t => t.length > 2).forEach(t => xhrNameTokens.add(t));
    };
    addTokens(ev.home);
    addTokens(ev.away);
    xhrEventPairs.push({ home: ev.home, away: ev.away, isLive: ev.isLive, eventId: ev.eventId });
  }

  const hasXhrData = xhrEvents.length > 0;

  const domEvents: ScrapedEvent[] = await page.evaluate(
    ({
      sport,
      isLive,
      xhrTokens,
      hasXhrFilter,
    }: {
      sport: Sport;
      isLive: boolean;
      xhrTokens: string[];
      hasXhrFilter: boolean;
    }) => {
      const result: ScrapedEvent[] = [];
      const tokenSet = new Set(xhrTokens);

      // Find all odds buttons
      const betBtns = Array.from(document.querySelectorAll(
        '[class*="betOdd"],[class*="OddsButton"],[class*="odds-button"],[data-testid*="odd"],[class*="price-button"],[class*="selectionPrice"]'
      )) as HTMLElement[];

      const containerSet = new Set<HTMLElement>();

      for (const btn of betBtns) {
        const txt = (btn.textContent ?? "").trim().replace(",", ".");
        const v = parseFloat(txt);
        if (isNaN(v) || v < 1.01 || v > 100) continue;

        // Walk up to find event row container (one with 2-4 odds siblings)
        let el: HTMLElement | null = btn.parentElement as HTMLElement;
        for (let i = 0; i < 8 && el && el !== document.body; i++) {
          const oddsInEl = Array.from(el.querySelectorAll(
            '[class*="betOdd"],[class*="OddsButton"],[class*="odds-button"],[data-testid*="odd"],[class*="price-button"],[class*="selectionPrice"]'
          ) as NodeListOf<HTMLElement>).filter(c => {
            const v2 = parseFloat((c.textContent ?? "").trim().replace(",", "."));
            return !isNaN(v2) && v2 >= 1.01 && v2 <= 100;
          });
          if (oddsInEl.length >= 2 && oddsInEl.length <= 4) {
            containerSet.add(el);
            break;
          }
          el = el.parentElement as HTMLElement;
        }
      }

      for (const container of containerSet) {
        const oddsEls = Array.from(container.querySelectorAll(
          '[class*="betOdd"],[class*="OddsButton"],[class*="odds-button"],[data-testid*="odd"],[class*="price-button"],[class*="selectionPrice"]'
        )) as HTMLElement[];

        const numericOdds = oddsEls
          .map(e => parseFloat((e.textContent ?? "").trim().replace(",", ".")))
          .filter(v => !isNaN(v) && v >= 1.01 && v <= 100);

        if (numericOdds.length < 2) continue;

        // Extract team names — walk up to event row then harvest non-numeric text
        let eventEl: HTMLElement | null = container.parentElement as HTMLElement;
        let teamNames: string[] = [];
        for (let depth = 0; depth < 10 && eventEl && eventEl !== document.body; depth++) {
          const textEls = Array.from(eventEl.querySelectorAll("*") as NodeListOf<HTMLElement>)
            .filter(e => {
              // Only leaf elements with actual text
              const directText = Array.from(e.childNodes)
                .filter(n => n.nodeType === 3)
                .map(n => n.textContent ?? "")
                .join("").trim();
              return directText.length > 1;
            })
            .map(e => (e.textContent ?? "").trim())
            .filter(t => {
              if (t.length < 2 || t.length > 60) return false;
              // Skip numeric and score patterns
              const v2 = parseFloat(t.replace(",", "."));
              if (!isNaN(v2) && v2 >= 1.0 && v2 <= 100) return false;
              if (/^\d+:\d+$/.test(t) || /^\d+'\s*$/.test(t)) return false;
              if (/^[0-9]+$/.test(t)) return false;
              return true;
            });

          const uniqueNames = [...new Set(textEls)].filter(t => t.length > 2 && t.length < 50);

          // Need at least 2 names; stop if too many odds containers seen above
          const oddsAbove = (eventEl.querySelectorAll(
            '[class*="betOdd"],[class*="OddsButton"],[class*="odds-button"],[data-testid*="odd"]'
          ) as NodeListOf<Element>).length;
          if (oddsAbove > numericOdds.length * 3) break; // gone too high

          if (uniqueNames.length >= 2) {
            teamNames = uniqueNames.slice(0, 2);
            break;
          }
          eventEl = eventEl.parentElement as HTMLElement;
        }

        if (teamNames.length < 2) continue;

        // If we have XHR data, filter DOM events to only known teams
        if (hasXhrFilter && tokenSet.size > 0) {
          const matchesXhr = teamNames.some(name =>
            name.toLowerCase().split(/[\s,.-]+/).filter(t => t.length > 2)
              .some(token => tokenSet.has(token))
          );
          if (!matchesXhr) continue;
        }

        const eventName = `${teamNames[0]} - ${teamNames[1]}`;
        const eventKey = `${sport.toLowerCase()}:${teamNames[0].toLowerCase().slice(0, 10)}:${teamNames[1].toLowerCase().slice(0, 10)}:nodate`;
        const outcomes: H2HOutcome[] = numericOdds.slice(0, 3).map((odds, i) => ({
          name: (["1", "X", "2"] as const)[i] ?? String(i + 1),
          odds,
        }));

        result.push({
          bookmaker: "betsson",
          sport,
          eventKey,
          eventName,
          isLive,
          market: "h2h",
          outcomes,
        } as ScrapedEvent);
      }

      return result;
    },
    {
      sport,
      isLive,
      xhrTokens: Array.from(xhrNameTokens),
      hasXhrFilter: hasXhrData,
    },
  );

  return domEvents;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isBrowserCrash(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("browser has been closed") ||
    msg.includes("target closed") ||
    msg.includes("context or browser has been closed")
  );
}

export class BetssonScraper extends BaseScraper {
  readonly name = "betsson";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  private async scrapePage(url: string, sport: Sport, isLive: boolean, retried = false): Promise<ScrapedEvent[]> {
    let ctx: BrowserContext | null = null;
    const wsMessages: Array<{ payload: any }> = [];
    const xhrCaptures: Array<{ url: string; data: any }> = [];
    const events: ScrapedEvent[] = [];
    let browserCrashed = false;

    try {
      // Q1: route through residential proxy if configured — betsson.fr now blocks OVH datacenter IPs
      const proxyHint = getProxyForScraper("betsson");
      ctx = await browserManager.createContext(proxyHint);
      const page = await ctx.newPage();
      // Block media that wastes RAM
      await page.route("**/*", (route: any) => {
        const t: string = route.request().resourceType();
        if (["image", "stylesheet", "font", "media", "other"].includes(t)) return route.abort();
        return route.continue();
      });

      page.on("websocket", (ws: any) => {
        const wsUrl: string = ws.url();
        // Q1: capture both SSB and Kambi CDN WebSocket URLs
        const isBetssonWs = wsUrl.includes("betsson") || wsUrl.includes("velnt") ||
          wsUrl.includes("kambi") || wsUrl.includes("kambicdn") || wsUrl.includes("offering");
        if (!isBetssonWs) return;
        ws.on("framereceived", (frame: any) => {
          const raw = frame.payload;
          const payloadStr = typeof raw === "string" ? raw :
            (Buffer.isBuffer(raw) ? raw.toString("utf8") :
            (raw && typeof raw === "object" ? (() => { try { return Buffer.from(raw as any).toString("utf8"); } catch { return ""; } })() : ""));
          if (payloadStr.length < 10) return;
          try {
            const parsed = JSON.parse(payloadStr);
            if (parsed?.data) {
              wsMessages.push({ payload: parsed });
            } else if (parsed?.events || parsed?.OFFERING) {
              // Q1: Kambi CDN offering format
              wsMessages.push({ payload: { data: [{ contentId: { type: "kambi_offering" }, change: parsed }] } });
            }
          } catch { /* binary or non-JSON ping frames */ }
        });
      });

      page.on("response", async (res: any) => {
        if (res.status() !== 200) return;
        const ct: string = res.headers()?.["content-type"] ?? "";
        if (!ct.includes("json")) return;
        try {
          const data = await res.json();
          const str = JSON.stringify(data);
          if (str.length > 100) xhrCaptures.push({ url: res.url(), data });
        } catch { /* ok */ }
      });

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 55_000 });
      await dismissCookies(page);
      // Event-driven: exit as soon as first WS message or XHR arrives (max 15s)
      const captureDeadline = Date.now() + 15_000;
      while (wsMessages.length === 0 && xhrCaptures.length === 0 && Date.now() < captureDeadline) {
        await new Promise<void>((r) => setTimeout(r, 200));
      }
      // Grace window: collect simultaneous WS frames + additional XHR
      if (wsMessages.length > 0 || xhrCaptures.length > 0) {
        await new Promise<void>((r) => setTimeout(r, 2_000));
      }

      // ── 1. Parse WS messages ───────────────────────────────────────────────
      const { state: wsState, typeCounts, marketSample } = parseWsMarkets(wsMessages);

      this.log(`WS: ${wsMessages.length} msgs, types: ${JSON.stringify(typeCounts)}`);
      this.log(`WS state: ${wsState.events.size} events, ${wsState.wsMarkets.size} markets`);

      // Log first market WS message in full — critical for diagnosing price format
      if (marketSample) {
        this.log(`WS market sample (${marketSample.length} chars): ${marketSample.slice(0, 3000)}`);
      } else {
        this.log(`WS market sample: none (no market-type messages received)`);
      }

      // ── 2. Parse XHR events ────────────────────────────────────────────────
      const allXhrEvents = parseXhrEvents(xhrCaptures);
      const sportCodes = SPORT_CODES[sport]!;
      const sportXhrEvents = allXhrEvents.filter(ev =>
        sportCodes.some(code => ev.sportType.toLowerCase() === code.toLowerCase()) ||
        sportCodes.some(code => ev.sportType.toLowerCase().includes(code.toLowerCase()))
      );

      // Log ALL captured XHR URLs (to discover price endpoints)
      const betssonXhr = xhrCaptures.filter(c =>
        c.url.includes("betsson") || c.url.includes("bson") || c.url.includes("velnt") || c.url.includes("kambi")
      );
      this.log(`XHR: ${xhrCaptures.length} total, ${betssonXhr.length} betsson/kambi, ${allXhrEvents.length} events parsed (${sportXhrEvents.length} ${sport})`);
      if (xhrCaptures.length > 0) {
        this.log(`XHR URLs: ${xhrCaptures.slice(0, 10).map(c => c.url.replace(/https?:\/\/[^/]+/, "").slice(0, 65)).join(" | ")}`);
      }

      // ── 3. Try WS events + markets ────────────────────────────────────────
      const sportCodesLower = sportCodes.map(c => c.toLowerCase());
      const wsEvents = [...wsState.events.values()].filter(ev =>
        sportCodesLower.some(code =>
          ev.sportType.toLowerCase() === code || ev.sportType.toLowerCase().includes(code)
        )
      );

      this.log(`WS ${sport} events: ${wsEvents.length}, markets with odds: ${wsState.wsMarkets.size}`);

      for (const ev of wsEvents) {
        const eventName = `${ev.home} - ${ev.away}`;
        const eventKey = buildEventKey(sport, eventName);
        const outcomes: H2HOutcome[] = [];

        // Find markets for this event
        for (const market of wsState.wsMarkets.values()) {
          if (market.eventId !== ev.eventId) continue;
          if (market.selections.length >= 2) {
            for (const sel of market.selections.slice(0, 3)) {
              outcomes.push({ name: sel.name, odds: sel.odds });
            }
            break;
          }
        }

        if (outcomes.length >= 2) {
          events.push({ bookmaker: "betsson", sport, eventKey, eventName, isLive: ev.isLive || isLive, market: "h2h", outcomes });
        }
      }

      if (events.length > 0) {
        this.log(`WS parsed: ${events.length} ${sport} events with odds`);
      } else {
        this.log(`WS: 0 events with odds for ${sport}`);
      }

      // ── 4. Kambi format XHR — try any captured Kambi offering API response ──
      for (const { data } of xhrCaptures) {
        const kambiEvts = parseKambiEvents(data, sport, isLive);
        if (kambiEvts.length > 0) {
          const wsKeys = new Set(events.map(e => e.eventKey));
          const kambiNew = kambiEvts.filter(e => !wsKeys.has(e.eventKey));
          this.log(`Kambi XHR: ${kambiEvts.length} total, ${kambiNew.length} new ${sport} events`);
          events.push(...kambiNew);
        }
      }

      // ── 5. DOM fallback — always run to supplement WS ─────────────────────
      // WS only delivers prices for events currently featured on the page.
      // DOM captures ALL rendered events (with correct prices from the page).
      // Combine: WS events take precedence; DOM fills the rest.
      {
        const wsXhrEvents: XhrEvent[] = [
          ...sportXhrEvents,
          ...wsEvents.map(ev => ({
            eventId: ev.eventId,
            home: ev.home,
            away: ev.away,
            sportType: ev.sportType,
            isLive: ev.isLive,
            marketIds: [],
          } as XhrEvent)),
        ];
        const mergeSource = wsXhrEvents.length > 0 ? wsXhrEvents : allXhrEvents;
        const domEvents = await domExtract(page, sport, isLive, mergeSource);

        if (domEvents.length > 0) {
          // Add DOM events not already covered by WS (de-duplicate by eventKey)
          const wsKeys = new Set(events.map(e => e.eventKey));
          const domNew = domEvents.filter(de => !wsKeys.has(de.eventKey));
          this.log(`DOM extracted: ${domEvents.length} total, ${domNew.length} new (filtered by ${mergeSource.length} known events)`);
          events.push(...domNew);
        } else {
          this.log(`DOM: 0 events`);
        }
      }

      this.log(`${isLive ? "Live" : "Prematch"} ${sport}: ${events.length} events`);
    } catch (err) {
      if (isBrowserCrash(err) && !retried) {
        this.warn(`Browser crash (${sport}) — reiniciando Chromium (backoff 1500ms)`);
        browserCrashed = true;
      } else {
        this.warn(`${sport} ${isLive ? "live" : "prematch"} failed`, err);
      }
    } finally {
      if (ctx) {
        await ctx.close().catch(() => {});
      } else {
        // createContext() failed — semaphore was never wrapped into ctx.close()
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

  async scrapeLive(): Promise<ScrapedEvent[]> {
    if (isScraperInCooldown(this.name)) { this.warn("En cooldown — omitiendo ciclo live"); return []; }
    const all: ScrapedEvent[] = [];
    try {
      for (const sport of this.sports) all.push(...await this.scrapePage(URLS[sport]!.live, sport, true));
    } catch (err) {
      setScraperCooldown(this.name);
      this.warn("scrapeLive fallido — circuit breaker activado", err);
    }
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (isScraperInCooldown(this.name)) { this.warn("En cooldown — omitiendo ciclo prematch"); return []; }
    const all: ScrapedEvent[] = [];
    try {
      for (const sport of this.sports) all.push(...await this.scrapePage(URLS[sport]!.prematch, sport, false));
    } catch (err) {
      setScraperCooldown(this.name);
      this.warn("scrapePrematch fallido — circuit breaker activado", err);
    }
    return all;
  }
}
