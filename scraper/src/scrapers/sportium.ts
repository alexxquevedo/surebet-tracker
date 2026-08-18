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
import type { Page, Response as PlaywrightResponse } from "playwright";
import { BaseScraper } from "./base";
import { browserManager, getProxyForScraper } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
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

    const filter = KAMBI_SPORT_FILTER[sport].toLowerCase();
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

      const fallbackUrl = `${KAMBI_BASE_V2018}/betoffer/group.json?lang=es&market=ES&category=${KAMBI_SPORT_FILTER[sport]}&numberOfEvents=200&clientId=2&includedBetOfferCategories=`;
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

// ── Axios fallback path (direct, no proxy) ────────────────────────────────────
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

async function fetchKambi(sport: Sport, isLive: boolean): Promise<any | null> {
  // Primary: Playwright + residential proxy (BoringSSL TLS, Spanish residential IP)
  const playwrightData = await fetchKambiViaPlaywright(sport, isLive).catch(() => null);
  if (playwrightData) return playwrightData;

  // Fallback: direct Node.js/axios (no proxy — useful in dev, or if proxy not configured)
  const filter = KAMBI_SPORT_FILTER[sport].toLowerCase();
  if (isLive) {
    const urlV2 = `${KAMBI_BASE_V2}/listView/${filter}/${filter}/all/all/in-play.json?lang=es&market=ES&includeParticipants=true`;
    const r2 = await httpsGet(urlV2);
    if (!BLOCKED_STATUSES.has(r2.status) && r2.data) return r2.data;

    const urlFallback = `${KAMBI_BASE_V2018}/liveEvent/get.json?lang=es&market=ES&startRowIndex=0&numberOfRows=150&filter=${filter.toUpperCase()}&includeParticipants=true`;
    const rf = await httpsGet(urlFallback);
    return BLOCKED_STATUSES.has(rf.status) ? null : rf.data;
  } else {
    const urlV2 = `${KAMBI_BASE_V2}/listView/${filter}/${filter}/all/all.json?lang=es&market=ES&numberOfEvents=200`;
    const r2 = await httpsGet(urlV2);
    if (!BLOCKED_STATUSES.has(r2.status) && r2.data?.events?.length) return r2.data;

    const urlFallback = `${KAMBI_BASE_V2018}/betoffer/group.json?lang=es&market=ES&category=${filter.toUpperCase()}&numberOfEvents=200&clientId=2&includedBetOfferCategories=`;
    const rf = await httpsGet(urlFallback);
    return BLOCKED_STATUSES.has(rf.status) ? null : rf.data;
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
