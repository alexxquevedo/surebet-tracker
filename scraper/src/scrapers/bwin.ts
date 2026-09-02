/**
 * Bwin España — cliente HTTP puro sobre sports.bwin.es (CDS API v1).
 *
 * El dominio bwin.fr bloqueaba IPs de OVH/datacenter.
 * bwin.es usa la misma plataforma CDS de Entain pero con endpoint español.
 *
 * Flujo:
 *   1. Health-check GET /counts (sin proxy) — si 403, reintenta con BWIN_PROXY_URL.
 *   2. GET /fixture-view?lang=es&sportIds=4,5,7&state=Live|Latest
 *   3. Parsear fixtures CDS (mismo formato que bwin.fr).
 */

import axios, { AxiosInstance } from "axios";
import https from "https";
import { createProxiedAxios } from "./proxy-helper";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine } from "../types";
import { saveFailedPayload, browserManager, getProxyForScraper, setScraperCooldown, isScraperInCooldown } from "./playwright-base";
import { config } from "../config";

const BASE_ES    = "https://sports.bwin.es/cds/api/v1";
const BASE_ES_V2 = "https://sports.bwin.es/cds-api/mfe/sportsbook/v2";

const APP_CONTEXT = JSON.stringify({ application: { id: 2, type: 1 }, channel: { id: 1, type: 1 } });

const DEFAULT_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
  "x-app-context": APP_CONTEXT,
  Origin: "https://sports.bwin.es",
  Referer: "https://sports.bwin.es/es/apuestas-deportivas",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Sport IDs confirmed from bwin CDS (Football=4, Tennis=5, Basketball=7)
const SPORT_IDS: Partial<Record<Sport, number>> = {
  FOOTBALL:   4,
  TENNIS:     5,
  BASKETBALL: 7,
};

const SPORT_NAMES: Partial<Record<Sport, string[]>> = {
  FOOTBALL:   ["football", "soccer", "fútbol", "futbol"],
  TENNIS:     ["tennis", "tenis"],
  BASKETBALL: ["basketball", "baloncesto", "basket"],
};

const SPORT_EXCLUDE: Partial<Record<Sport, string[]>> = {
  FOOTBALL:   ["football us", "football américain", "american football", "fútbol americano", "futbol americano"],
  TENNIS:     [],
  BASKETBALL: [],
};

// ─── Axios instances ──────────────────────────────────────────────────────────

function makeClient(proxyUrl?: string): AxiosInstance {
  // Strict TLS for direct connections
  const httpsAgent = new https.Agent({ rejectUnauthorized: true, keepAlive: true });
  const instance = axios.create({
    baseURL: BASE_ES,
    timeout: 15_000,
    headers: DEFAULT_HEADERS,
    httpsAgent,
  });

  if (proxyUrl) {
    // Delegate SOCKS5/HTTP proxy to createProxiedAxios; set baseURL so relative paths resolve
    const proxyInst = createProxiedAxios(proxyUrl, 15_000, DEFAULT_HEADERS);
    proxyInst.defaults.baseURL = BASE_ES;
    return proxyInst;
  }

  return instance;
}

// ─── Widget fixture extractor ─────────────────────────────────────────────────
// Extracts fixtures from bwin.es widget/widgetdata JSON responses.
// The SPA delivers events via widget types TabbedGrid and OutrightsGrid.

const WIDGET_FIXTURE_TYPES = new Set([
  "TabbedGrid", "OutrightsGrid", "Grid", "LiveGrid", "FixturesWidget",
  "EventsWidget", "SportsWidget", "LiveEventsWidget",
]);

const SPORT_IDS_REVERSE: Partial<Record<number, Sport>> = { 4: "FOOTBALL", 5: "TENNIS", 7: "BASKETBALL" };

function extractWidgetFixtures(widgets: any[]): any[] {
  const seen = new Set<number>();
  const out: any[] = [];
  for (const w of widgets) {
    if (!w.hasData) continue;
    const payload = w.payload;
    if (!payload) continue;
    let fixtures: any[] = payload.fixtures ?? [];
    if (!fixtures.length && Array.isArray(payload.pods)) {
      fixtures = (payload.pods as any[]).flatMap((pod: any) => pod.fixtures ?? []);
    }
    for (const f of fixtures) {
      if (!f || !f.id || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
    }
  }
  return out;
}

// ─── CDS fixture parser ───────────────────────────────────────────────────────

function parseCdsFixtures(data: any, sport: Sport, isLive: boolean): ScrapedEvent[] {
  const events: ScrapedEvent[] = [];

  let fixtures: any[] =
    data?.fixtures ??
    (Array.isArray(data?.splitFixtures) && data.splitFixtures.length > 0 ? data.splitFixtures : null) ??
    (Array.isArray(data?.fixture) ? data.fixture : data?.fixture ? [data.fixture] : null) ??
    (Array.isArray(data) ? data : []);

  if (fixtures.length === 0 && Array.isArray(data?.sportsOffer)) {
    const sportNames = SPORT_NAMES[sport]!;
    const sportExclude = SPORT_EXCLUDE[sport]!;
    const matchingSo = (data.sportsOffer as any[]).filter((so: any) => {
      const soName: string = (so?.sport?.name?.value ?? so?.sport?.name ?? so?.name ?? "").toLowerCase();
      return soName && sportNames.some(n => soName.includes(n)) && !sportExclude.some(x => soName.includes(x));
    });
    fixtures = matchingSo.flatMap((so: any) => so?.fixtures ?? so?.fixtureList ?? []);
  }

  for (const fixture of fixtures) {
    // When fixture has a sport.id field, filter to avoid cross-sport contamination
    if (fixture.sport?.id !== undefined) {
      const expectedId = SPORT_IDS[sport];
      if (expectedId !== undefined && fixture.sport.id !== expectedId) continue;
    }

    const participants: any[] = fixture.participants ?? fixture.fixture?.participants ?? [];
    let home = "", away = "";
    for (const p of participants) {
      const name: string = p.name?.value ?? p.name ?? "";
      const role: string = (p.participantRole ?? p.homeAway ?? "").toLowerCase();
      if (role.includes("home") || role === "1") home = name;
      else if (role.includes("away") || role === "2") away = name;
    }
    if (!home && !away && participants.length >= 2) {
      home = participants[0]?.name?.value ?? participants[0]?.name ?? "";
      away = participants[1]?.name?.value ?? participants[1]?.name ?? "";
    }
    if (!home && !away) continue;

    const eventName = `${home} - ${away}`;
    const startTime = fixture.startDate ? new Date(fixture.startDate) : undefined;
    const eventKey = buildEventKey(sport, eventName, isLive ? undefined : startTime);
    const league: string =
      fixture.eventLeague?.name?.value ?? fixture.league?.name?.value ??
      fixture.competition?.name?.value ?? fixture.competition?.name ?? "";

    const markets: any[] = fixture.markets ?? fixture.betOffers ?? fixture.optionMarkets ?? [];
    for (const market of markets) {
      const mName: string = (market.name?.value ?? market.betOfferType?.name ?? market.name ?? "").toLowerCase();
      const outcomes: any[] = market.outcomes ?? market.selections ?? market.options ?? [];

      const isCombo = mName.includes(" et ") || mName.includes(" and ") || mName.includes("y ") ||
        mName.includes("btts") || mName.includes("les deux équipes") || mName.includes("ambos equipos");

      if (!isCombo && (
        mName.includes("resultado") || mName.includes("ganador") ||
        mName.includes("résultat") || mName.includes("vainqueur") ||
        mName.includes("1x2") || mName.includes("match result") || mName.includes("match winner")
      )) {
        const h2h: H2HOutcome[] = outcomes.map((o: any) => {
          const rawOdds = o.price?.decimal ?? o.price?.odds ?? o.odds ?? 0;
          const odds = rawOdds > 100 ? rawOdds / 1000 : Number(rawOdds);
          const name: string = o.name?.value ?? o.label ?? o.type ?? o.name ?? "";
          return odds >= 1.01 && name ? { name, odds } : null;
        }).filter(Boolean) as H2HOutcome[];

        if (h2h.length >= 2) {
          events.push({ bookmaker: "bwin", sport, eventKey, eventName, league, startTime, isLive, market: "h2h", outcomes: h2h });
        }
      } else if (mName.includes("más/menos") || mName.includes("plus/moins") || mName.includes("over/under") || mName.includes("total")) {
        const byLine = new Map<number, TotalsLine>();
        for (const o of outcomes) {
          const lbl: string = (o.name?.value ?? o.label ?? "").toLowerCase();
          const lm = lbl.match(/(\d+[.,]\d+)/);
          if (!lm) continue;
          const line = parseFloat(lm[1].replace(",", "."));
          const rawOdds = o.price?.decimal ?? o.price?.odds ?? o.odds ?? 0;
          const odds = rawOdds > 100 ? rawOdds / 1000 : Number(rawOdds);
          if (odds < 1.01) continue;
          const entry = byLine.get(line) ?? { line, over: 0, under: 0 };
          if (lbl.includes("más") || lbl.includes("plus") || lbl.includes("over") || lbl.includes("+")) entry.over = odds;
          else entry.under = odds;
          byLine.set(line, entry);
        }
        const totals = [...byLine.values()].filter(t => t.over > 0 && t.under > 0);
        if (totals.length > 0) {
          events.push({ bookmaker: "bwin", sport, eventKey, eventName, league, startTime, isLive, market: "totals", outcomes: totals });
        }
      }
    }
  }
  return events;
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

export class BwinScraper extends BaseScraper {
  readonly name = "bwin";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];
  private prematchCache: { ts: number; events: ScrapedEvent[] } | null = null;
  private readonly PREMATCH_CACHE_TTL = 12 * 60 * 1000;

  private async fetchFixtures(state: "Live" | "Latest", retried = false): Promise<{ data: any; usedProxy: boolean } | null> {
    const proxyUrl = config.scraperProxies.bwin;
    const sportIds = Object.values(SPORT_IDS).join(",");
    const path = `fixture-view?lang=es&country=ES&marketGroupTypes=Standard&sportIds=${sportIds}&state=${state}&offerMapping=WithPredefinedAndAdditional&sortBy=StartDate&fixture-limit=100`;

    // 1. Quick health-check without proxy
    const directClient = makeClient();
    try {
      const hc = await directClient.get("counts?lang=es&country=ES");
      if (hc.status === 200) {
        const res = await directClient.get(path);
        const data = res.data;
        if (data?.error) {
          this.warn(`bwin.es direct: responseData.error = ${JSON.stringify(data.error).slice(0, 120)}`);
          if (!retried) { await sleep(2000); return this.fetchFixtures(state, true); }
          return null;
        }
        return { data, usedProxy: false };
      }
    } catch (err: any) {
      const status: number = err?.response?.status ?? 0;
      if (status !== 403 && status !== 0) {
        this.warn(`bwin.es direct error ${status} — ${err?.message}`);
        return null;
      }
      this.warn(`bwin.es direct 403/blocked — ${proxyUrl ? "intentando proxy" : "sin BWIN_PROXY_URL configurada"}`);
    }

    // 2. Retry with proxy if available
    if (!proxyUrl) {
      this.warn("Sin BWIN_PROXY_URL — no se puede reintentar con proxy. Configura proxy ES en .env");
      return null;
    }

    try {
      const proxyClient = makeClient(proxyUrl);
      const res = await proxyClient.get(path);
      const data = res.data;
      if (data?.error) {
        this.warn(`bwin.es proxy: responseData.error = ${JSON.stringify(data.error).slice(0, 120)}`);
        if (!retried) { await sleep(2000); return this.fetchFixtures(state, true); }
        return null;
      }
      return { data, usedProxy: true };
    } catch (err: any) {
      this.warn(`bwin.es proxy error: ${err?.response?.status ?? err?.message}`);
      return null;
    }
  }

  private async fetchV2(sport: Sport, isLive: boolean): Promise<any | null> {
    const sportId = SPORT_IDS[sport];
    const proxyUrl = config.scraperProxies.bwin;
        const path = `sports/${sportId}/events?lang=es&facility=composite${isLive ? '&state=InPlay' : '&sort=StartDate&maxItems=100'}`;
    // Direct attempt first
    try {
      const d = axios.create({ baseURL: BASE_ES_V2, timeout: 15_000, headers: { ...DEFAULT_HEADERS } });
      const res = await d.get(path);
      if (res.data) return res.data;
    } catch { /* fall through */ }
    // Proxy attempt — createProxiedAxios handles socks5h:// correctly
    if (!proxyUrl) return null;
    try {
      const p = createProxiedAxios(proxyUrl, 15_000, { ...DEFAULT_HEADERS });
      p.defaults.baseURL = BASE_ES_V2;
      const res = await p.get(path);
      return res.data ?? null;
    } catch { return null; }
  }

  /**
   * Q3: Playwright fallback — intercepts the cds-api XHR from the bwin.es SPA.
   * Chromium (BoringSSL TLS) bypasses the JA3 fingerprinting that Axios triggers.
   * Uses one page load for all sports combined, then parses per-sport.
   */
  private async fetchViaPlaywright(isLive: boolean): Promise<any[] | null> {
    const proxyHint = getProxyForScraper("bwin");
    if (!proxyHint) return null;

    const { page, ctx } = await browserManager.newPage(proxyHint, undefined, 30_000);
    const captured: any[] = [];

    // Hard 38-second timeout — must fit inside the 60s orchestrator window
    // (Axios takes ~20s to fail, leaving ~40s for Playwright)
    return await new Promise<any[] | null>((resolve) => {
      let settled = false;
      const closeAndResolve = async (result: any[] | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        await ctx.close().catch(() => {});
        resolve(result);
      };

      const hardTimeout = setTimeout(() => {
        const totalFx = captured.reduce((s, d) => s + (d?.fixtures?.length ?? 0), 0);
        this.warn(`bwin Playwright hard timeout (38s) — ${captured.length} responses, ${totalFx} fixtures`);
        void closeAndResolve(captured.length > 0 ? [...captured] : null);
      }, 38_000);

      (async () => {
        try {
          page.setDefaultNavigationTimeout(10_000);
          page.on("response", async (res: any) => {
            if (res.status() !== 200) return;
            const u: string = res.url();
            if (!u.includes("/widget/widgetdata") && !u.includes("/widget/personalizedWidgetData")) return;
            try {
              const data = await Promise.race([res.json(), new Promise<null>(r => setTimeout(r, 3_000, null))]);
              if (data && Array.isArray(data.widgets)) {
                const fixtures = extractWidgetFixtures(data.widgets);
                if (fixtures.length > 0) {
                  this.log(`bwin PW widget: ${fixtures.length} fixtures from ${u.replace(/\?.*/,"").slice(-50)}`);
                  captured.push({ fixtures });
                }
              }
            } catch { /* ok */ }
          });

          // Load the sport page directly — bwin.es homepage already returns widget data for
          // all featured sports, then navigate to sport-specific pages only if needed.
          // Both live and prematch use the en-vivo page — it reliably triggers widgetdata
          // (the widget includes upcoming fixtures). For prematch, parseCdsFixtures uses
          // isLive=false so eventKeys get date suffixes from startTime.
          const entryUrl = "https://www.bwin.es/es/sports/en-vivo/futbol";

          await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(3_000);

          // If the entry page didn't return widget data (unlikely), try homepage as fallback
          if (captured.length === 0) {
            await page.goto("https://www.bwin.es", { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(3_000);
          }

          // If still missing sports, fetch remaining sport pages
          const hasSports = new Set(
            captured.flatMap(d => (d.fixtures ?? []).map((f: any) => SPORT_IDS_REVERSE[f.sport?.id]).filter(Boolean))
          );
          const missingUrls = isLive
            ? [
                !hasSports.has("TENNIS")     && "https://www.bwin.es/es/sports/en-vivo/tenis",
                !hasSports.has("BASKETBALL") && "https://www.bwin.es/es/sports/en-vivo/baloncesto",
              ].filter(Boolean) as string[]
            : [
                !hasSports.has("TENNIS")     && "https://www.bwin.es/es/sports/en-vivo/tenis",
                !hasSports.has("BASKETBALL") && "https://www.bwin.es/es/sports/en-vivo/baloncesto",
              ].filter(Boolean) as string[];

          for (const url of missingUrls) {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(2_000);
          }

          const totalFx = captured.reduce((s, d) => s + (d?.fixtures?.length ?? 0), 0);
          this.log(`Playwright bwin: ${captured.length} widget responses, ${totalFx} total fixtures`);
          await closeAndResolve(captured.length > 0 ? captured : null);
        } catch (err) {
          this.warn(`Playwright bwin error: ${(err as any)?.message}`);
          await closeAndResolve(null);
        }
      })();
    });
  }

  private async scrape(isLive: boolean): Promise<ScrapedEvent[]> {
    const result = await this.fetchFixtures(isLive ? "Live" : "Latest");

    const all: ScrapedEvent[] = [];

    if (result) {
      const { data, usedProxy } = result;
      if (usedProxy) this.log("Usando proxy para bwin.es");
      const topKeys = typeof data === "object" ? Object.keys(data ?? {}).slice(0, 8).join(", ") : String(data).slice(0, 80);
      this.log(`bwin.es fixture-view (${isLive ? "Live" : "Prematch"}) v1: keys=[${topKeys}]`);

      for (const sport of this.sports) {
        const events = parseCdsFixtures(data, sport, isLive);
        if (events.length > 0) {
          this.log(`${isLive ? "Live" : "Prematch"} ${sport}: ${events.length} events (v1)`);
          all.push(...events);
        } else {
          this.warn(`${isLive ? "Live" : "Prematch"} ${sport}: 0 eventos v1, probando v2`);
        }
      }
    }

    // v2 fallback only if v1 returned some data (missing sports only)
    // If v1 returned null (403 blocked), v2 is also blocked — skip straight to Playwright
    if (result !== null) {
      const missingSports = this.sports.filter(sp => !all.some(e => e.sport === sp));
      for (const sport of missingSports) {
        const v2data = await this.fetchV2(sport, isLive);
        if (!v2data) { saveFailedPayload("bwin", sport, "0_events_v2_null", null); continue; }
        const topKeys = typeof v2data === "object" ? Object.keys(v2data ?? {}).slice(0, 8).join(", ") : String(v2data).slice(0, 60);
        this.log(`bwin v2 ${sport}: keys=[${topKeys}]`);
        const events = parseCdsFixtures(v2data, sport, isLive);
        if (events.length > 0) {
          this.log(`${isLive ? "Live" : "Prematch"} ${sport}: ${events.length} events (v2)`);
          all.push(...events);
        } else {
          saveFailedPayload("bwin", sport, "0_events_v2", v2data);
        }
      }
    }

    // v2 prematch direct — different endpoint from v1; may not share the same 403 block.
    // Runs when v1 returned null AND we still have no events AND this is a prematch cycle.
    if (result === null && !isLive && all.length === 0) {
      for (const sport of this.sports) {
        const v2data = await this.fetchV2(sport, false);
        if (!v2data) continue;
        const ev2 = parseCdsFixtures(v2data, sport, false);
        if (ev2.length > 0) { this.log(`Prematch v2 direct ${sport}: ${ev2.length} events`); all.push(...ev2); }
      }
    }

    // Q3: Playwright fallback — Chromium BoringSSL bypasses JA3 TLS fingerprinting
    // that causes Axios 502 when routing through proxy. Only invoked when Axios found 0 events.
    const coveredSports = new Set(all.map(e => e.sport));
    const missingSportsForPW = this.sports.filter(sp => !coveredSports.has(sp));
    if (all.length === 0 || missingSportsForPW.length > 0) {
      this.warn("Axios: 0 events — intentando Playwright + proxy (Q3)");
      const pwData = await this.fetchViaPlaywright(isLive).catch(() => null);
      if (pwData) {
        for (const data of pwData) {
          for (const sport of this.sports) {
            const events = parseCdsFixtures(data, sport, isLive);
            all.push(...events);
          }
        }
        if (all.length > 0) this.log(`Playwright: ${all.length} eventos recuperados`);
        else this.warn(`Playwright: 0 eventos (${pwData.reduce((s, d) => s + (d?.fixtures?.length ?? 0), 0)} fixtures en data)`);
      }
    }

    return all;
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    if (isScraperInCooldown(this.name)) { this.warn("En cooldown — omitiendo ciclo live"); return []; }
    try {
      return await this.scrape(true);
    } catch (err) {
      setScraperCooldown(this.name);
      this.warn("scrapeLive fallido — circuit breaker activado", err);
      return [];
    }
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (isScraperInCooldown(this.name)) { this.warn("En cooldown — omitiendo ciclo prematch"); return []; }
    try {
      const events = await this.scrape(false);
      if (events.length > 0) {
        this.prematchCache = { ts: Date.now(), events };
        return events;
      }
      if (this.prematchCache && Date.now() - this.prematchCache.ts < this.PREMATCH_CACHE_TTL) {
        const ageS = Math.round((Date.now() - this.prematchCache.ts) / 1000);
        this.log(`Playwright: 0 events — using prematch cache (${this.prematchCache.events.length} events, ${ageS}s old)`);
        return this.prematchCache.events;
      }
      return events;
    } catch (err) {
      setScraperCooldown(this.name);
      this.warn("scrapePrematch fallido — circuit breaker activado", err);
      return [];
    }
  }
}
