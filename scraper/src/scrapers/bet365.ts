/**
 * Bet365 España — Playwright scraper.
 *
 * Bet365 usa Cloudflare Enterprise Bot Management con IP-reputation scoring.
 * El bloqueo desde IPs de datacenter (OVH, etc.) es a nivel de red — las patches
 * de fingerprint NO lo evitan sin un proxy residencial.
 *
 * Para habilitar: define BET365_PROXY_URL en .env (ej. "http://user:pass@host:port")
 * y opcionalmente BET365_PROXY_USER / BET365_PROXY_PASS si el proxy usa auth separada.
 *
 * Sin proxy el scraper registra el bloqueo limpiamente y devuelve 0 eventos.
 */

import { chromium, Browser } from "playwright";
import { browserManager, pageSemaphore, dismissCookies, parseOdds, logPageState, saveFailedPayload, parseProxyUrl, setScraperCooldown, isScraperInCooldown } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";
import { BaseScraper } from "./base";
import { config } from "../config";

// Per-scraper proxy (browser-level — Chromium requires this for auth to work)
const B365_PROXY_URL = config.scraperProxies.bet365;

// ─── URLs ────────────────────────────────────────────────────────────────────

const URLS: Partial<Record<Sport, { live: string; prematch: string }>> = {
  FOOTBALL:   { live: "https://www.bet365.es/#/IP/B1",  prematch: "https://www.bet365.es/#/AS/B1"  },
  TENNIS:     { live: "https://www.bet365.es/#/IP/B13", prematch: "https://www.bet365.es/#/AS/B13" },
  BASKETBALL: { live: "https://www.bet365.es/#/IP/B7",  prematch: "https://www.bet365.es/#/AS/B7"  },
};

const STEALTH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ─── Stealth script ──────────────────────────────────────────────────────────
// Cubre los vectores de detección más comunes. No bypasea IP-reputation de CF Enterprise,
// pero sí detectores de UA, canvas, WebGL, plugins, permissions, etc.

const STEALTH_SCRIPT = `
(() => {
  // 1. Remove webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  try { delete navigator.__proto__.webdriver; } catch (_) {}

  // 2. Remove Playwright/automation globals
  try { delete window.__playwright; } catch (_) {}
  try { delete window.__pw_manual; } catch (_) {}
  try { delete window._playwrightWorker; } catch (_) {}

  // 3. Plugins — headless Chromium has 0; real Chrome has 3+
  const fakePlugins = [
    { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
    { name: 'Native Client',      filename: 'internal-nacl-plugin', description: '', length: 2 },
  ];
  fakePlugins.refresh = () => {};
  fakePlugins.item = (i) => fakePlugins[i];
  fakePlugins.namedItem = (n) => fakePlugins.find(x => x.name === n) ?? null;
  Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });

  // 4. Languages
  Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es', 'en-GB', 'en'] });

  // 5. Hardware fingerprint
  Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'maxTouchPoints',      { get: () => 0 });
  Object.defineProperty(navigator, 'vendor',              { get: () => 'Google Inc.' });

  // 6. Connection
  try {
    Object.defineProperty(navigator, 'connection', {
      get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }),
    });
  } catch (_) {}

  // 7. Screen (1080p)
  const screenProps = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  for (const [k, v] of Object.entries(screenProps)) {
    try { Object.defineProperty(screen, k, { get: () => v }); } catch (_) {}
  }
  Object.defineProperty(window, 'outerWidth',  { get: () => 1920 });
  Object.defineProperty(window, 'outerHeight', { get: () => 1080 });

  // 8. WebGL vendor/renderer
  const patchWebGL = (ctx) => {
    if (!ctx) return;
    const orig = ctx.getParameter.bind(ctx);
    ctx.getParameter = (p) => {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris Pro OpenGL Engine';
      return orig(p);
    };
  };
  try {
    const canvas = document.createElement('canvas');
    patchWebGL(canvas.getContext('webgl'));
    patchWebGL(canvas.getContext('webgl2'));
    const OrigWebGLRC = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris Pro OpenGL Engine';
      return OrigWebGLRC.call(this, p);
    };
  } catch (_) {}

  // 9. Canvas noise (breaks canvas fingerprinting)
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type, q) {
    const result = origToDataURL.call(this, type, q);
    return result.slice(0, -6) + 'AAAAAA==';
  };

  // 10. chrome runtime object (missing in headless)
  if (!window.chrome) {
    window.chrome = {
      runtime: { connect: () => {}, sendMessage: () => {}, onMessage: { addListener: () => {}, removeListener: () => {} } },
      loadTimes: () => ({ requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000 }),
      csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: Date.now() }),
      app: { isInstalled: false },
    };
  }

  // 11. Notifications permission — "denied" not "prompt" (headless default gives "prompt")
  const origQuery = navigator.permissions?.query?.bind(navigator.permissions);
  if (origQuery) {
    navigator.permissions.query = (perm) =>
      perm.name === 'notifications'
        ? Promise.resolve({ state: 'denied', onchange: null })
        : origQuery(perm);
  }

  // 12. Battery API — return fake values so CF can't detect the headless lack of battery
  if (navigator.getBattery) {
    navigator.getBattery = () => Promise.resolve({
      charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1,
      addEventListener: () => {}, removeEventListener: () => {},
    });
  }
})();
`;

// ─── Dedicated Bet365 browser (proxy at browser level — required by Chromium) ─

let bet365Browser: Browser | null = null;

async function getBet365Browser(): Promise<Browser> {
  if (!bet365Browser?.isConnected()) {
    const executablePath = process.env.CHROMIUM_PATH || undefined;
    // Q4: parse proxy URL properly — embedded credentials in server string cause ERR_INVALID_AUTH_CREDENTIALS
    const proxyConfig = B365_PROXY_URL ? parseProxyUrl(B365_PROXY_URL) : undefined;
    bet365Browser = await chromium.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        // Q-A: suppress ERR_CERT_INVALID from proxy MITM SSL — must be at launch level,
        // ignoreHTTPSErrors on context does not apply during the initial TLS handshake.
        "--ignore-certificate-errors",
        "--ignore-certificate-errors-spki-list",
      ],
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
    });
  }
  return bet365Browser;
}

// ─── Bet365 WebSocket pipe parser ────────────────────────────────────────────
// Bet365 uses a proprietary pipe-delimited protocol over WS.
// Frames contain |MA| (Market) and |PA| (Price) blocks.
// Odds are in fractional format "A/B" → decimal = A/B + 1.

function fracToDecimal(frac: string): number {
  const m = frac.match(/^(\d+)\/(\d+)$/);
  if (!m) {
    const n = parseFloat(frac);
    return isNaN(n) ? 0 : n;
  }
  return parseInt(m[1]) / parseInt(m[2]) + 1;
}

function parseBet365Pipe(frames: string[], sport: Sport, isLive: boolean): ScrapedEvent[] {
  const events: ScrapedEvent[] = [];
  // We accumulate current market context and flush when we see a new one
  let currentEvent = "";
  let currentMarket = "";
  const pendingOutcomes: H2HOutcome[] = [];

  function flushEvent(): void {
    if (currentEvent && pendingOutcomes.length >= 2) {
      events.push({
        bookmaker: "bet365", sport,
        eventKey: buildEventKey(sport, currentEvent),
        eventName: currentEvent, isLive, market: "h2h",
        outcomes: [...pendingOutcomes],
      });
    }
    pendingOutcomes.length = 0;
  }

  for (const raw of frames) {
    const parts = raw.split("|").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p === "MA") {
        // MA block: |MA|event_id|event_name|market_name|...
        flushEvent();
        const evName = parts[i + 2] ?? "";
        const mktName = (parts[i + 3] ?? "").toLowerCase();
        if (evName.includes(" v ") || evName.includes(" vs ") || evName.includes(" - ")) {
          currentEvent = evName.replace(/ v /g, " - ").replace(/ vs /g, " - ");
          currentMarket = mktName;
        }
        i += 3;
      } else if (p === "PA") {
        // PA block: |PA|...|selection_name|fractional_odds|...
        // Try to find an adjacent fractional odds pattern
        const maybeName = parts[i + 1] ?? "";
        const maybeFrac = parts[i + 2] ?? "";
        if (maybeName && /^\d+\/\d+$/.test(maybeFrac)) {
          const odds = fracToDecimal(maybeFrac);
          if (odds >= 1.01 && currentEvent) {
            pendingOutcomes.push({ name: maybeName, odds });
          }
          i += 2;
        }
      }
    }
  }
  flushEvent();
  return events;
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class Bet365Scraper extends BaseScraper {
  readonly name = "bet365";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  private async scrapePage(
    url: string,
    sport: Sport,
    isLive: boolean,
    attempt = 0,
  ): Promise<ScrapedEvent[]> {
    await pageSemaphore.acquire();
    let ctx: any;
    try {
      // Dedicated browser with proxy at browser level (context-level proxy is not supported)
      const browser = await getBet365Browser();

      ctx = await browser.newContext({
        userAgent: STEALTH_UA,
        locale: "es-ES",
        timezoneId: "Europe/Madrid",
        viewport: { width: 1920, height: 1080 },
        extraHTTPHeaders: { "Accept-Language": "es-ES,es;q=0.9,en-GB;q=0.8,en;q=0.7" },
      });

      await ctx.addInitScript(STEALTH_SCRIPT);

      const events: ScrapedEvent[] = [];
      const wsFrames: string[] = [];
      const xhrCaptures: Array<{ url: string; data: any }> = [];

      const page = await ctx.newPage();

      page.on("websocket", (ws: any) => {
        const url = ws.url();
        if (!url.includes("bet365") && !url.includes("premws") && !url.includes("pshudws") && !url.includes("zap")) return;
        ws.on("framereceived", (frame: any) => {
          const raw = frame.payload;
          let payload = "";
          if (typeof raw === "string") {
            payload = raw;
          } else if (Buffer.isBuffer(raw)) {
            payload = raw.toString("utf8");
          } else if (raw && typeof raw === "object") {
            try { payload = Buffer.from(raw as any).toString("utf8"); } catch { /* binary frame */ }
          }
          if (payload.length > 20) wsFrames.push(payload);
        });
      });

      page.on("response", async (res: any) => {
        if (res.status() !== 200) return;
        const ct: string = res.headers()?.["content-type"] ?? "";
        if (!ct.includes("json")) return;
        const u: string = res.url();
        if (!u.includes("bet365")) return;
        try {
          const data = await res.json().catch(() => null);
          if (data && JSON.stringify(data).length > 100) xhrCaptures.push({ url: u, data });
        } catch { /* ok */ }
      });
      await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => {});

      const title = await page.title().catch(() => "");
      const cfDetected =
        title.toLowerCase().includes("just a moment") ||
        title.toLowerCase().includes("cloudflare") ||
        title.toLowerCase().includes("attention required") ||
        title.toLowerCase().includes("access denied");

      if (cfDetected) {
        this.warn(`CF challenge (title: "${title}") — waiting 15s for JS challenge...`);
        await page.waitForTimeout(15_000);

        const titleAfter = await page.title().catch(() => "");
        const stillBlocked =
          titleAfter.toLowerCase().includes("just a moment") ||
          titleAfter.toLowerCase().includes("cloudflare") ||
          titleAfter.toLowerCase().includes("attention");

        if (stillBlocked && attempt < 2) {
          const backoff = attempt === 0 ? 8_000 : 20_000;
          this.warn(`Still blocked after JS challenge — retry ${attempt + 1}/2 in ${backoff / 1000}s`);
          await page.waitForTimeout(backoff);
          return this.scrapePage(url, sport, isLive, attempt + 1);
        }

        if (stillBlocked) {
          this.warn(
            "BLOCKED by Cloudflare — bet365 necesita proxy residencial. " +
            "Configura BET365_PROXY_URL en .env (ej: http://user:pass@host:port)",
          );
          return [];
        }
      } else {
        await page.waitForTimeout(3_000);
      }

      await dismissCookies(page);

      // Q4: mouse interactions to trigger WS topic subscriptions (bet365 ZAP protocol)
      await page.mouse.move(960, 300, { steps: 5 }).catch(() => {});
      await page.mouse.wheel(0, 200).catch(() => {});
      await page.waitForTimeout(1_500);
      await page.mouse.move(960, 500, { steps: 5 }).catch(() => {});

      await page
        .waitForSelector(
          "[class*='ip-EventInfoLine'], [class*='src-EventItem'], [class*='el-EventLayout'], [class*='gl-Market']",
          { timeout: 25_000 },
        )
        .catch(() => {});

      const finalTitle = await page.title().catch(() => "");
      this.log(`Page: "${finalTitle}" @ ${page.url()}`);

      // ── DOM scraping ────────────────────────────────────────────────────────
      const domEvents: ScrapedEvent[] = await page
        .evaluate(
          ({ sport, isLive }: { sport: Sport; isLive: boolean }) => {
            const result: ScrapedEvent[] = [];
            const rowSelectors = [
              "[class*='ip-EventInfoLine']",
              "[class*='src-EventItem']",
              "[class*='el-EventLayout']",
              "[class*='ip-EventContainer']",
              "[class*='src-ParticipantFixtureDetails']",
            ];

            let eventRows: Element[] = [];
            for (const sel of rowSelectors) {
              const els = Array.from(document.querySelectorAll(sel));
              if (els.length > 0) { eventRows = els; break; }
            }

            for (const row of eventRows) {
              const nameSelectors = [
                "[class*='ip-TeamName']", "[class*='src-EventName']",
                "[class*='el-TeamName']", "[class*='ip-ScoreBasedEvent']",
                "[class*='src-ParticipantLabel']",
              ];
              let rawName = "";
              for (const sel of nameSelectors) {
                const el = row.querySelector(sel);
                if (el) { rawName = (el.textContent ?? "").trim(); break; }
              }
              if (!rawName) {
                const teams = Array.from(row.querySelectorAll("[class*='ip-Team'], [class*='src-Team']"))
                  .map((e) => (e.textContent ?? "").trim())
                  .filter((t) => t.length > 1);
                if (teams.length >= 2) rawName = teams.join(" vs ");
              }
              if (!rawName || rawName.length < 3) continue;

              const eventName = rawName.replace(/\n+/g, " vs ");
              const eventKey = `${sport.toLowerCase()}:${eventName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20)}:nodate`;

              const oddsSelectors = [
                "[class*='gl-Participant_General']",
                "[class*='ip-Odds']", "[class*='src-OddsButton']",
                "[class*='gl-Participant']", "[class*='src-OddsBut']",
              ];
              const outcomes: H2HOutcome[] = [];
              const labels = ["1", "X", "2"];

              for (const sel of oddsSelectors) {
                const oddsEls = Array.from(row.querySelectorAll(sel)).slice(0, 3);
                if (oddsEls.length < 2) continue;
                for (let i = 0; i < oddsEls.length; i++) {
                  const txt = (oddsEls[i].textContent ?? "").trim().replace(",", ".");
                  const v = parseFloat(txt);
                  if (!isNaN(v) && v >= 1.01 && v <= 200) {
                    outcomes.push({ name: labels[i] ?? String(i + 1), odds: v });
                  }
                }
                if (outcomes.length >= 2) break;
              }

              if (outcomes.length >= 2) {
                result.push({ bookmaker: "bet365", sport, eventKey, eventName, isLive, market: "h2h", outcomes } as ScrapedEvent);
              }
            }
            return result;
          },
          { sport, isLive },
        )
        .catch(() => []);

      // Recalculate eventKey server-side — page.evaluate has no access to buildEventKey
      events.push(...domEvents.map(e => ({ ...e, eventKey: buildEventKey(e.sport as Sport, e.eventName) })));

      // Parse WebSocket pipe frames if DOM gave nothing
      if (events.length === 0 && wsFrames.length > 0) {
        this.log(`Bet365 WS: ${wsFrames.length} frames — trying pipe parser`);
        const wsEvents = parseBet365Pipe(wsFrames, sport, isLive);
        if (wsEvents.length > 0) {
          this.log(`Bet365 pipe parser: ${wsEvents.length} events`);
          events.push(...wsEvents);
        } else {
          // Log sample frames so we can diagnose the format
          this.warn(`Bet365 pipe: 0 events from ${wsFrames.length} frames. Sample: ${wsFrames[0]?.slice(0, 200)}`);
        }
      }

      if (events.length === 0) {
        if (xhrCaptures.length > 0) {
          this.log(`XHR (${xhrCaptures.length}): ${xhrCaptures.map((c) => c.url.replace(/https?:\/\/[^/]+/, "").slice(0, 60)).join(" | ")}`);
        }
        if (wsFrames.length === 0) {
          this.warn(`Bet365 WS: 0 frames captured — Cloudflare bloqueando WS o URL incorrecta`);
        }
        await logPageState(page, this.name);
      } else {
        this.log(`${isLive ? "Live" : "Prematch"} ${sport}: ${events.length} events`);
      }
      return events;
    } catch (err) {
      this.warn(`${sport} failed`, err);
      return [];
    } finally {
      try { if (ctx) await ctx.close(); } catch { /* ignore close errors */ }
      pageSemaphore.release();
    }
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    if (isScraperInCooldown(this.name)) { this.warn("En cooldown — omitiendo ciclo live"); return []; }
    const all: ScrapedEvent[] = [];
    try {
      for (const sport of this.sports) all.push(...(await this.scrapePage(URLS[sport]!.live, sport, true)));
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
      for (const sport of this.sports) all.push(...(await this.scrapePage(URLS[sport]!.prematch, sport, false)));
    } catch (err) {
      setScraperCooldown(this.name);
      this.warn("scrapePrematch fallido — circuit breaker activado", err);
    }
    return all;
  }
}
