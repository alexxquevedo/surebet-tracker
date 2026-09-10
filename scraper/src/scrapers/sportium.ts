/**
 * Sportium España (Cirsa) — Kambi Offering API.
 *
 * Primary path: Playwright + residential proxy (Chromium/BoringSSL avoids Node.js JA3 detection).
 * Fallback path: direct axios (no proxy, for dev environments without SPORTIUM_PROXY_URL).
 *
 * Kambi CDN (eu-offering.kambicdn.org) blocks datacenter IPs and may check JA3 TLS fingerprints.
 * Navigating via Playwright (BoringSSL) with a Spanish residential proxy bypasses both filters.
 * Referer + Origin headers are injected via page.setExtraHTTPHeaders() — no full page render needed.
 */

import * as https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Page, Response as PlaywrightResponse } from "playwright";
import { BaseScraper } from "./base";
import { browserManager, getProxyForScraper } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine } from "../types";

// Q5: updated customer IDs — "sportiumes" is the 2026 customer key for Sportium ES.
// Fallback: "sisp" (old) then "pafes" (alternative). Change here if Kambi returns 404.
const KAMBI_CUSTOMER        = "sportiumes";
const KAMBI_CUSTOMER_LEGACY = "sisp";
const KAMBI_BASE_V2    = `https://eu-offering.kambicdn.org/offering/v2/${KAMBI_CUSTOMER}`;
const KAMBI_BASE_V2018 = `https://eu-offering.kambicdn.org/offering/v2018/${KAMBI_CUSTOMER}`;

const KAMBI_SPORT_FILTER: Partial<Record<Sport, string>> = {
  FOOTBALL:          "football",
  TENNIS:            "tennis",
  BASKETBALL:        "basketball",
  AMERICANFOOTBALL:  "american-football",
  ICEHOCKEY:         "ice-hockey",
  BASEBALL:          "baseball",
};

const KAMBI_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://sports.sportium.es/",
  "Origin": "https://sports.sportium.es",
  "X-Requested-With": "XMLHttpRequest",
};

const BLOCKED_STATUSES = new Set([403, 429, 451]);

// Q-B: proxy for native Node.js HTTPS fallback path (Playwright primary path uses getProxyForScraper)
const SPORTIUM_PROXY_URL = process.env.SPORTIUM_PROXY_URL ?? "";

// ── Challenge detection helpers ────────────────────────────────────────────────

function isCloudflareChallenge(httpStatus: number, bodySnippet: string): boolean {
  if (httpStatus === 403 || httpStatus === 429) return true;
  const lower = bodySnippet.toLowerCase();
  return (
    (lower.includes("just a moment") && lower.includes("cloudflare")) ||
    lower.includes("cf_clearance") ||
    lower.includes("challenge-platform")
  );
}

async function getBodySnippet(page: Page): Promise<string> {
  return page.evaluate(() => {
    const pre = document.querySelector("pre");
    return (pre?.textContent ?? document.body?.innerText ?? "").slice(0, 600);
  }).catch(() => "");
}

/**
 * Navigate to m.sportium.es to seed Cloudflare cookies into the browser context.
 * The Kambi CDN shares the same CF zone, so cookies acquired here satisfy its
 * Bot Management challenge on the subsequent API request.
 *
 * Q1: Uses page.context().cookies() (authoritative, from the browser's cookie store)
 * instead of document.cookie (JS-readable only — misses httpOnly cookies).
 * Polls every 400ms up to 7s. Returns true if challenge passed, false on hard error.
 * Early-exit path: if DOM is already clear and any cookies are present, CF was
 * not invoked (site loaded clean) — no need to wait for the full 7s.
 */
async function warmUpSportiumCookies(page: Page): Promise<boolean> {
  try {
    await page.goto("https://m.sportium.es", {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    }).catch(() => null);

    const deadline = Date.now() + 7_000;
    while (Date.now() < deadline) {
      const cookies = await page.context().cookies("https://m.sportium.es").catch(() => []);
      const hasCfClearance = cookies.some((c) => c.name === "cf_clearance");

      if (hasCfClearance) return true;

      const isChallengeActive = await page.evaluate((): boolean =>
        !!(
          document.querySelector("#challenge-running") ||
          document.querySelector(".cf-wrapper") ||
          document.querySelector("#cf-challenge-body")
        )
      ).catch(() => false);

      // No cf_clearance but DOM is clean and site set some cookies → loaded without CF challenge
      if (!isChallengeActive && cookies.length > 0) break;

      await new Promise<void>((r) => setTimeout(r, 400));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Dual event-loop flush between sequential Playwright fetches (Q3).
 * 1. page.evaluate() round-trip forces a CDP IPC reply, guaranteeing all
 *    preceding browser response events have been dispatched to Node.js.
 * 2. setImmediate() yields to Node.js I/O phase where Playwright's CDP
 *    WebSocket message handlers run, draining any buffered response events.
 */
async function drainEventLoops(page: Page): Promise<void> {
  if (!page.isClosed()) {
    await page.evaluate(() => undefined).catch(() => {});
  }
  await new Promise<void>((r) => setImmediate(r));
}

// ── Playwright primary path ────────────────────────────────────────────────────
/**
 * Fetch Kambi JSON via Playwright + residential proxy.
 * Chromium uses BoringSSL → JA3 hash matches real Chrome, not Node.js OpenSSL.
 * extraHTTPHeaders injects Referer/Origin so Kambi CDN sees a request from sportium.es.
 *
 * P1: Cloudflare Bot Management detection — if 403 or CF HTML markers are found,
 * warm up CF cookies via m.sportium.es and retry the API call.
 *
 * P3: waitForResponse predicates are version-path-isolated (/v2/ vs /v2018/).
 * A URL cannot match both, so the v2018 listener can NEVER capture a v2 response.
 * A page.evaluate() micro-flush drains any pending response events between fetches.
 */
async function fetchKambiViaPlaywright(
  sport: Sport,
  isLive: boolean
): Promise<any | null> {
  const proxyHint = getProxyForScraper("sportium");
  if (!proxyHint) return null;

  const { page, ctx } = await browserManager.newPage(proxyHint);
  try {
    await page.setExtraHTTPHeaders(KAMBI_HEADERS);

    const filter = KAMBI_SPORT_FILTER[sport]!.toLowerCase();
    const apiUrlV2 = isLive
      ? `${KAMBI_BASE_V2}/listView/${filter}/${filter}/all/all/in-play.json?lang=es&market=ES&includeParticipants=true`
      : `${KAMBI_BASE_V2}/listView/${filter}/${filter}/all/all.json?lang=es&market=ES&numberOfEvents=200`;

    // Version-isolated predicates (P3): mutually exclusive URL path segments.
    // /offering/v2/ and /offering/v2018/ cannot both appear in the same URL,
    // so each listener is guaranteed to capture only responses from its own fetch.
    const isV2 = (r: PlaywrightResponse): boolean =>
      r.url().includes("kambicdn.org") &&
      r.url().includes("/offering/v2/") &&
      r.request().method() === "GET";
    const isV2018 = (r: PlaywrightResponse): boolean =>
      r.url().includes("kambicdn.org") &&
      r.url().includes("/offering/v2018/") &&
      r.request().method() === "GET";

    let data: any = null;

    // ── Primary fetch: v2 ─────────────────────────────────────────────────────
    // Capture any status (not just 200) so 403 CF challenges are detectable.
    const [v2Resp] = await Promise.all([
      page.waitForResponse(isV2, { timeout: 12_000 }).catch(() => null),
      page.goto(apiUrlV2, { waitUntil: "commit", timeout: 12_000 }).catch(() => null),
    ]);

    if (v2Resp?.status() === 200) {
      data = await v2Resp.json().catch(() => null);
    }

    // ── DOM text + CF challenge check ─────────────────────────────────────────
    if (!data) {
      const bodySnippet = await getBodySnippet(page);
      const trimmed = bodySnippet.trim();
      // Browser renders JSON API responses as plain text inside <pre>
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try { data = JSON.parse(trimmed); } catch { /* non-JSON body */ }
      }
      // P1: Cloudflare challenge — warm up cookies via m.sportium.es and retry
      if (!data && isCloudflareChallenge(v2Resp?.status() ?? 0, bodySnippet)) {
        const warmedUp = await warmUpSportiumCookies(page);
        if (!warmedUp) {
          console.warn("[Sportium] Cloudflare warm-up failed or timed out. Aborting v2 retry.");
          return null;
        }
        const [v2Retry] = await Promise.all([
          page.waitForResponse(isV2, { timeout: 12_000 }).catch(() => null),
          page.goto(apiUrlV2, { waitUntil: "commit", timeout: 12_000 }).catch(() => null),
        ]);
        if (v2Retry?.status() === 200) {
          data = await v2Retry.json().catch(() => null);
        }
        if (!data) {
          const retryBody = await getBodySnippet(page);
          const rt = retryBody.trim();
          if (rt.startsWith("{") || rt.startsWith("[")) {
            try { data = JSON.parse(rt); } catch { /* non-JSON */ }
          }
        }
      }
    }

    // ── Fallback: v2018 ───────────────────────────────────────────────────────
    if (!data && !isLive) {
      await drainEventLoops(page);

      const fallbackUrl = `${KAMBI_BASE_V2018}/betoffer/group.json?lang=es&market=ES&category=${(KAMBI_SPORT_FILTER[sport] ?? "").toUpperCase().replace(/-/g, "_")}&numberOfEvents=200&clientId=2&includedBetOfferCategories=`;
      const [v2018Resp] = await Promise.all([
        page.waitForResponse(isV2018, { timeout: 8_000 }).catch(() => null),
        page.goto(fallbackUrl, { waitUntil: "commit", timeout: 10_000 }).catch(() => null),
      ]);
      if (v2018Resp?.status() === 200) {
        data = await v2018Resp.json().catch(() => null);
      }
    }

    return data;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── Axios fallback path — uses proxy if SPORTIUM_PROXY_URL is set ─────────────
function httpsGet(url: string): Promise<{ data: any; status: number }> {
  return new Promise((resolve) => {
    const options: https.RequestOptions = {
      headers: KAMBI_HEADERS,
      // Q-B: route through residential proxy to bypass Kambi CDN datacenter geo-block
      // Cast needed: HttpsProxyAgent extends http.Agent but TS types don't align in v7
      ...(SPORTIUM_PROXY_URL ? { agent: new HttpsProxyAgent(SPORTIUM_PROXY_URL) as any } : {}),
    };
    const req = https.get(url, options, (res) => {
      const chunks: Buffer[] = [];
      // Q5: log non-200 status codes for diagnostics instead of silently returning null
      if ((res.statusCode ?? 0) !== 200) {
        console.error(`[sportium] Kambi HTTP ${res.statusCode} — ${url.slice(0, 80)}`);
      }
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve({ data: JSON.parse(Buffer.concat(chunks).toString()), status: res.statusCode ?? 0 }); }
        catch { resolve({ data: null, status: res.statusCode ?? 0 }); }
      });
    });
    req.on("error", (err) => {
      console.error(`[sportium] Kambi network error — ${err.message} — ${url.slice(0, 80)}`);
      resolve({ data: null, status: 0 });
    });
    req.setTimeout(15_000, () => { req.destroy(); resolve({ data: null, status: 0 }); });
  });
}

// Q5: try primary then legacy customer key
async function httpsGetWithFallback(url: string): Promise<{ data: any; status: number }> {
  const r = await httpsGet(url);
  if (r.status !== 404) return r;
  // 404 = customer ID not found → try legacy
  const fallbackUrl = url.replace(`/${KAMBI_CUSTOMER}/`, `/${KAMBI_CUSTOMER_LEGACY}/`);
  console.warn(`[sportium] 404 on "${KAMBI_CUSTOMER}" — retrying with "${KAMBI_CUSTOMER_LEGACY}"`);
  return httpsGet(fallbackUrl);
}

async function fetchKambi(sport: Sport, isLive: boolean): Promise<any | null> {
  // Primary: Playwright + residential proxy (BoringSSL TLS, Spanish residential IP)
  const playwrightData = await fetchKambiViaPlaywright(sport, isLive).catch(() => null);
  if (playwrightData) return playwrightData;

  // Fallback: direct Node.js/axios (no proxy — useful in dev, or if proxy not configured)
  const filter = KAMBI_SPORT_FILTER[sport]!.toLowerCase();
  const filterCat = filter.toUpperCase().replace(/-/g, "_"); // "rugby-league" → "RUGBY_LEAGUE"
  if (isLive) {
    const urlV2 = `${KAMBI_BASE_V2}/listView/${filter}/${filter}/all/all/in-play.json?lang=es&market=ES&includeParticipants=true`;
    const r2 = await httpsGetWithFallback(urlV2);
    if (!BLOCKED_STATUSES.has(r2.status) && r2.data) return r2.data;

    const urlFallback = `${KAMBI_BASE_V2018}/liveEvent/get.json?lang=es&market=ES&startRowIndex=0&numberOfRows=150&filter=${filterCat}&includeParticipants=true`;
    const rf = await httpsGetWithFallback(urlFallback);
    return BLOCKED_STATUSES.has(rf.status) ? null : rf.data;
  } else {
    const urlV2 = `${KAMBI_BASE_V2}/listView/${filter}/${filter}/all/all.json?lang=es&market=ES&numberOfEvents=200`;
    const r2 = await httpsGetWithFallback(urlV2);
    if (!BLOCKED_STATUSES.has(r2.status) && r2.data?.events?.length) return r2.data;

    const urlFallback = `${KAMBI_BASE_V2018}/betoffer/group.json?lang=es&market=ES&category=${filterCat}&numberOfEvents=200&clientId=2&includedBetOfferCategories=`;
    const rf = await httpsGetWithFallback(urlFallback);
    return BLOCKED_STATUSES.has(rf.status) ? null : rf.data;
  }
}

// ─── Kambi market classification (shared with kambi.ts) ───────────────────────

const CRITERION_TO_MARKET_SP: Array<[RegExp, string]> = [
  [/BOTH_TEAMS_TO_SCORE|BOTH_TEAMS_SCORE/i,           "btts"],
  [/DOUBLE_CHANCE/i,                                   "double_chance"],
  [/ASIAN_HANDICAP/i,                                  "asian_handicap"],
  [/EUROPEAN_HANDICAP|HANDICAP/i,                      "handicap"],
  [/MATCH_RESULT|MATCH_WINNER|FULL_TIME_RESULT|1_1$/i, "h2h"],
  [/CORNER/i,                                          "corners"],
  [/YELLOW_CARD|BOOKING/i,                             "yellow_cards"],
  [/RED_CARD/i,                                        "red_cards"],
  [/CARD/i,                                            "cards"],
  [/SHOT/i,                                            "shots"],
  [/HALF_TIME/i,                                       "h1_goals"],
  [/ACE/i,                                             "aces"],
  [/DOUBLE_FAULT/i,                                    "double_faults"],
  [/GAME/i,                                            "games"],
  [/SET/i,                                             "sets"],
  [/OVER_UNDER|GOALS_OVER_UNDER/i,                     "goals"],
  [/POINTS/i,                                          "match_points"],
  [/RUN/i,                                             "runs"],
  [/STRIKEOUT/i,                                       "strikeouts"],
  [/SAVE/i,                                            "goalie_saves"],
];

const LABEL_TO_MARKET_SP: Array<[RegExp, string]> = [
  [/ambos\s+marcan|both\s+teams\s+score|btts/i,        "btts"],
  [/doble\s+oportunidad|double\s+chance/i,              "double_chance"],
  [/asi[aá]tico|asian\s+handicap/i,                    "asian_handicap"],
  [/h[aá]ndicap/i,                                     "handicap"],
  [/c[oó]rner|esquina/i,                               "corners"],
  [/tarjetas?\s+amarillas?/i,                           "yellow_cards"],
  [/tarjetas?\s+rojas?/i,                               "red_cards"],
  [/tarjetas?/i,                                        "cards"],
  [/disparos?|tiros?|shots?/i,                          "shots"],
  [/primera\s+mitad|half[\s-]time|1ª\s*parte/i,         "h1_goals"],
  [/segunda\s+mitad|2nd\s+half|2ª\s*parte/i,            "h2_goals"],
  [/\baces?\b/i,                                        "aces"],
  [/dobles?\s+faltas?/i,                                "double_faults"],
  [/\bjuegos?\b/i,                                      "games"],
  [/\bsets?\b/i,                                        "sets"],
  [/goles?\s+totales?|total\s+goles?|over\s*\/\s*under/i, "goals"],
  [/total\s+puntos?|points?\s+totales?/i,               "match_points"],
  [/carreras?\s+totales?/i,                             "runs"],
  [/strikeouts?|ponches?/i,                             "strikeouts"],
  [/paradas?|saves?/i,                                  "goalie_saves"],
  [/1\s*x\s*2|resultado\s+final|match\s+result/i,       "h2h"],
];

function classifySportiumOffer(offer: any): string | null {
  const criterionType = offer.criterion?.type ?? "";
  const label = (offer.criterion?.label ?? offer.criterion?.englishLabel ?? offer.betOfferType?.name ?? "").toLowerCase();
  for (const [re, market] of CRITERION_TO_MARKET_SP) {
    if (re.test(criterionType)) return market;
  }
  for (const [re, market] of LABEL_TO_MARKET_SP) {
    if (re.test(label)) return market;
  }
  return null;
}

const kOddsSp = (raw: any): number => {
  const n = Number(raw ?? 0);
  return n >= 100 ? n / 1000 : n;
};

const kLineSp = (raw: any): number => {
  const n = Number(raw ?? 0);
  return isFinite(n) ? n / 1000 : 0;
};

function parseSportiumOffer(
  offer: any,
  market: string,
  sport: Sport,
  eventKey: string,
  eventName: string,
  startTime: Date | undefined,
  isLive: boolean,
): ScrapedEvent[] {
  if (offer.suspended || offer.closed) return [];
  const outcomes: any[] = offer.outcomes ?? [];

  if (market === "h2h" || market === "btts" || market === "double_chance" || market === "handicap") {
    const h2h: H2HOutcome[] = outcomes.map((o: any) => {
      const odds = kOddsSp(o.odds);
      if (odds < 1.01) return null;
      let name: string = o.englishLabel ?? o.label ?? String(o.type ?? "");
      if (name === "OT_ONE")          name = "1";
      if (name === "OT_CROSS")        name = "X";
      if (name === "OT_TWO")          name = "2";
      if (name === "OT_YES")          name = "Yes";
      if (name === "OT_NO")           name = "No";
      if (name === "OT_ONE_OR_CROSS") name = "1X";
      if (name === "OT_CROSS_OR_TWO") name = "X2";
      if (name === "OT_ONE_OR_TWO")   name = "12";
      if (!name) return null;
      return { name, odds } as H2HOutcome;
    }).filter((x): x is H2HOutcome => x !== null);
    if (h2h.length < 2) return [];
    return [{ bookmaker: "sportium", sport, eventKey, eventName, startTime, isLive, market, outcomes: h2h }];
  }

  if (market === "asian_handicap") {
    const lines: TotalsLine[] = [];
    const subOffers: any[] = offer.rangeBetOffers?.length ? offer.rangeBetOffers : [offer];
    for (const sub of subOffers) {
      const lineVal = kLineSp(sub.line ?? offer.line);
      const subOuts: any[] = sub.outcomes ?? [];
      const homeOut = subOuts.find((o: any) => o.type === "OT_ONE" || /home|1$/i.test(o.label ?? ""));
      const awayOut = subOuts.find((o: any) => o.type === "OT_TWO" || /away|2$/i.test(o.label ?? ""));
      if (!homeOut || !awayOut) continue;
      const homeOdds = kOddsSp(homeOut.odds);
      const awayOdds = kOddsSp(awayOut.odds);
      if (homeOdds < 1.01 || awayOdds < 1.01) continue;
      lines.push({ line: lineVal, over: homeOdds, under: awayOdds });
    }
    if (!lines.length) return [];
    return [{ bookmaker: "sportium", sport, eventKey, eventName, startTime, isLive, market: "asian_handicap", outcomes: lines }];
  }

  // O/U markets (goals, corners, cards, shots, sets, games, runs, etc.)
  const byLine = new Map<number, { over: number; under: number }>();
  const subOffers: any[] = offer.rangeBetOffers?.length ? offer.rangeBetOffers : [offer];
  for (const sub of subOffers) {
    const subOuts: any[] = sub.outcomes ?? [];
    const lineFromOffer = kLineSp(sub.line ?? 0);
    for (const o of subOuts) {
      const odds = kOddsSp(o.odds);
      if (odds < 1.01) continue;
      const t = String(o.type ?? "").toUpperCase();
      const isOver  = t === "OT_OVER"  || /over|más\s*de/i.test(o.label ?? "");
      const isUnder = t === "OT_UNDER" || /under|menos\s*de/i.test(o.label ?? "");
      if (!isOver && !isUnder) continue;
      const lm = (o.label ?? "").match(/(\d+[.,]\d+|\d+)/);
      const line = lm ? parseFloat(lm[1].replace(",", ".")) : lineFromOffer;
      if (!line && line !== 0) continue;
      const cur = byLine.get(line) ?? { over: 0, under: 0 };
      if (isOver  && odds > cur.over)  cur.over  = odds;
      if (isUnder && odds > cur.under) cur.under = odds;
      byLine.set(line, cur);
    }
  }
  const totals: TotalsLine[] = [...byLine.entries()]
    .filter(([, { over, under }]) => over >= 1.01 && under >= 1.01)
    .map(([line, { over, under }]) => ({ line, over, under }));
  if (!totals.length) return [];
  return [{ bookmaker: "sportium", sport, eventKey, eventName, startTime, isLive, market, outcomes: totals }];
}

function parseLive(data: any, sport: Sport): ScrapedEvent[] {
  const eventList: any[] = data?.liveEvents ?? data?.events ?? [];
  const events: ScrapedEvent[] = [];
  for (const item of eventList) {
    const ev = item.event ?? item;
    const eventName: string = ev.name ?? "";
    if (!eventName) continue;
    const eventKey = buildEventKey(sport, eventName);
    const allOffers: any[] = [...(item.betOffers ?? []), ...(item.rangeBetOffers ?? [])];
    for (const offer of allOffers) {
      const market = classifySportiumOffer(offer);
      if (!market) continue;
      events.push(...parseSportiumOffer(offer, market, sport, eventKey, eventName, undefined, true));
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
        const allOffers: any[] = [...(item.betOffers ?? []), ...(item.rangeBetOffers ?? [])];
        for (const offer of allOffers) {
          const market = classifySportiumOffer(offer);
          if (!market) continue;
          events.push(...parseSportiumOffer(offer, market, sport, eventKey, eventName, startTime, false));
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
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "AMERICANFOOTBALL", "ICEHOCKEY", "BASEBALL"];

  private async scrapeOneSport(sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    try {
      const data = await fetchKambi(sport, isLive);
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
    if (!SPORTIUM_PROXY_URL) { this.log("Sin SPORTIUM_PROXY_URL"); return []; }
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) all.push(...(await this.scrapeOneSport(sport, true)));
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    if (!SPORTIUM_PROXY_URL) { this.log("Sin SPORTIUM_PROXY_URL"); return []; }
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) all.push(...(await this.scrapeOneSport(sport, false)));
    return all;
  }
}
