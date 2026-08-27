/**
 * Shared Playwright browser manager — single Chromium instance for all scrapers.
 * Keeps one browser open, creates a fresh context per scrape to isolate cookies/sessions.
 */

import * as fs from "fs";
import * as path from "path";
import { chromium, Browser, BrowserContext, CDPSession, Page } from "playwright";
import { config } from "../config";
import { randomUA, jitterDelay } from "./ua-pool";
import { reportBlock, reportSuccess } from "./ip-rotator";
import { logger } from "../logger";

const CTX_BASE_OPTIONS = {
  locale: "es-ES",
  timezoneId: "Europe/Madrid",
  viewport: { width: 1920, height: 1080 },
  extraHTTPHeaders: { "Accept-Language": "es-ES,es;q=0.9,en;q=0.8" },
};

// ─── Scraper Circuit Breaker ─────────────────────────────────────────────────
// Prevents a failing scraper from repeatedly hammering the semaphore.
// On failure → 3-min cooldown; caller checks isScraperInCooldown() before acquiring.

interface CooldownState {
  until: number;       // epoch ms when cooldown expires
  consecutive: number; // consecutive 403/crash count — drives backoff exponent
}

const scraperCooldowns = new Map<string, CooldownState>();

// Exponential backoff: 3min → 6min → 12min → 24min → 60min (cap)
const BACKOFF_BASE_MS = 3 * 60 * 1000;
const BACKOFF_MAX_MS  = 60 * 60 * 1000;

function backoffDuration(consecutive: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, consecutive - 1), BACKOFF_MAX_MS);
}

export function setScraperCooldown(scraperName: string): void {
  const prev = scraperCooldowns.get(scraperName);
  const consecutive = (prev?.consecutive ?? 0) + 1;
  const duration = backoffDuration(consecutive);
  scraperCooldowns.set(scraperName, { until: Date.now() + duration, consecutive });
  logger.warn("circuit_breaker.cooldown", { bookmaker: scraperName, consecutive, cooldownMs: duration });
}

/** Reset backoff counter when a scraper returns events after a cooldown period. */
export function resetScraperCooldown(scraperName: string): void {
  const prev = scraperCooldowns.get(scraperName);
  if (prev && prev.consecutive > 0) {
    scraperCooldowns.set(scraperName, { until: 0, consecutive: 0 });
    logger.info("circuit_breaker.recovered", { bookmaker: scraperName, prevConsecutive: prev.consecutive });
  }
}

/** Convenience: set cooldown + feed IP rotator in one call (for Playwright scrapers). */
export function trigger403Block(scraperName: string, httpStatus: number): void {
  setScraperCooldown(scraperName);
  logger.warn("scraper.blocked", { bookmaker: scraperName, httpStatus });
  void reportBlock(scraperName, httpStatus);
}

export function isScraperInCooldown(scraperName: string): boolean {
  const state = scraperCooldowns.get(scraperName);
  return state ? Date.now() < state.until : false;
}

/** Snapshot of all cooldown states — used by the health file writer. */
export function getScraperCooldownStates(): Record<string, { inCooldown: boolean; consecutive: number; cooldownUntil?: string }> {
  const out: Record<string, { inCooldown: boolean; consecutive: number; cooldownUntil?: string }> = {};
  for (const [name, state] of scraperCooldowns) {
    const inCooldown = Date.now() < state.until;
    out[name] = { inCooldown, consecutive: state.consecutive, ...(inCooldown ? { cooldownUntil: new Date(state.until).toISOString() } : {}) };
  }
  return out;
}

// ─── Proxy URL parser (shared by scrapers that launch their own browser) ─────

export function parseProxyUrl(rawUrl: string): { server: string; username?: string; password?: string } | undefined {
  if (!rawUrl) return undefined;
  try {
    const u = new URL(rawUrl);
    const server   = `${u.protocol}//${u.hostname}:${u.port}`;
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    return { server, ...(username ? { username, password } : {}) };
  } catch {
    return { server: rawUrl };
  }
}

class BrowserManager {
  private directBrowser: Browser | null = null;
  private proxyBrowser: Browser | null = null;
  private consecutiveCrashCount = 0;
  private coolDownUntil = 0;
  private lastPingMs = 0;
  private readonly PING_INTERVAL_MS = 30_000;

  private async launchChromium(proxy?: { server: string; username?: string; password?: string }): Promise<Browser> {
    const executablePath = process.env.CHROMIUM_PATH || undefined;
    return chromium.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
      ...(proxy ? { proxy } : {}),
    });
  }

  // Direct browser (no proxy) — used by Betsson, Winamax, etc.
  async getBrowser(): Promise<Browser> {
    if (this.coolDownUntil > Date.now()) {
      const remaining = Math.ceil((this.coolDownUntil - Date.now()) / 1000);
      throw new Error(`BrowserManager en cool-down — espera ${remaining}s antes del próximo intento`);
    }
    if (this.directBrowser) {
      if (!this.directBrowser.isConnected()) {
        // WebSocket to browser process closed — tear down and relaunch
        await this.shutdown();
      } else {
        // Async zombie ping: creates a throwaway context with 500ms timeout
        const alive = await this.pingBrowser(this.directBrowser);
        if (!alive) {
          console.warn("[BrowserManager] Zombie detectado (ping timeout 500ms) — shutdown forzado");
          await this.shutdown();
        }
      }
    }
    if (!this.directBrowser) {
      this.directBrowser = await this.launchChromium(
        config.proxy.enabled
          ? {
              server: `http://${config.proxy.host}:${config.proxy.port}`,
              username: config.proxy.username || undefined,
              password: config.proxy.password || undefined,
            }
          : undefined,
      );
    }
    return this.directBrowser;
  }

  // Residential proxy browser — launched with proxy at browser level (Chromium requires this;
  // context-level proxy auth is not supported and throws ERR_PROXY_AUTH_UNSUPPORTED).
  private async getResidentialBrowser(proxy: { server: string; username?: string; password?: string }): Promise<Browser> {
    if (!this.proxyBrowser?.isConnected()) {
      this.proxyBrowser = await this.launchChromium(proxy);
    }
    return this.proxyBrowser;
  }

  // Creates a browser context with the semaphore already acquired.
  // The ctx.close() wrapper releases the semaphore — always call it (or releaseSemaphore()).
  async createContext(proxyHint?: { server: string; username?: string; password?: string }): Promise<BrowserContext> {
    await pageSemaphore.acquire();
    try {
      const browser = proxyHint
        ? await this.getResidentialBrowser(proxyHint)
        : await this.getBrowser();
      const ctx = await browser.newContext({
        ...CTX_BASE_OPTIONS,
        userAgent: randomUA(), // rotate UA per browser context
        // Q2: disabling strict cert checks for proxied contexts prevents MITM TLS errors
        ...(proxyHint ? { ignoreHTTPSErrors: true } : {}),
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        // @ts-ignore
        delete navigator.__proto__.webdriver;
      });
      const originalClose = ctx.close.bind(ctx);
      ctx.close = async () => {
        try { await originalClose(); } catch { /* browser may already be gone */ } finally { pageSemaphore.release(); }
      };
      return ctx;
    } catch (err) {
      // Context never created — release semaphore manually
      pageSemaphore.release();
      if (!proxyHint) { try { await this.directBrowser?.close(); } catch { /* ignore */ } this.directBrowser = null; }
      throw err;
    }
  }

  // Explicit semaphore release for callers that acquired via createContext() but
  // never got a context object (catch branch where ctx === null).
  releaseSemaphore(): void {
    pageSemaphore.release();
  }

  // proxyHint truthy → route through residential proxy browser.
  // Pass result of getProxyForScraper(name) — returns undefined for direct scrapers.
  async newPage(
    proxyHint?: { server: string; username?: string; password?: string },
    scraperName?: string,
  ): Promise<{ page: Page; ctx: BrowserContext }> {
    const ctx = await this.createContext(proxyHint);
    try {
      const page = await ctx.newPage();

      // Jitter before first navigation (proxy contexts only — mimics human think-time)
      if (proxyHint) await jitterDelay();

      // Detect 403/429 in any response and feed the IP rotator
      if (proxyHint) {
        page.on("response", (res: any) => {
          const status: number = res.status();
          if (status === 403 || status === 429) {
            const name = scraperName ?? "playwright";
            logger.warn("playwright.blocked", { bookmaker: name, httpStatus: status, url: String(res.url()).slice(0, 120) });
            if (scraperName) setScraperCooldown(scraperName);
            void reportBlock(name, status);
          } else if (status < 400 && scraperName) {
            reportSuccess(scraperName);
          }
        });
      }

      // Block media that wastes RAM (images, fonts, video) — speeds up load, reduces OOM risk
      await page.route("**/*", (route: any) => {
        const t: string = route.request().resourceType();
        if (["image", "stylesheet", "font", "media", "other"].includes(t)) return route.abort();
        return route.continue();
      });
      return { page, ctx };
    } catch (err) {
      await ctx.close().catch(() => {});
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    if (this.directBrowser) { await this.directBrowser.close(); this.directBrowser = null; }
    if (this.proxyBrowser) { await this.proxyBrowser.close(); this.proxyBrowser = null; }
  }

  recordCrash(): void {
    this.consecutiveCrashCount++;
    if (this.consecutiveCrashCount >= 3) {
      this.coolDownUntil = Date.now() + 60_000;
      console.warn(
        `[BrowserManager] ${this.consecutiveCrashCount} crashes consecutivos — cool-down 60s ` +
        `hasta ${new Date(this.coolDownUntil).toISOString()}`
      );
      this.consecutiveCrashCount = 0;
    }
  }

  recordSuccess(): void {
    this.consecutiveCrashCount = 0;
  }

  isCoolingDown(): boolean {
    return Date.now() < this.coolDownUntil;
  }

  private async pingBrowser(browser: Browser): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastPingMs < this.PING_INTERVAL_MS) return true;
    // CDP-level ping: Browser.getVersion is a lightweight round-trip (~1–5ms).
    // Avoids creating a full browser context (no renderer, no profile dir).
    // 800ms timeout (vs 500ms): accounts for VPS jitter under memory pressure
    // so a slow-but-live browser doesn't falsely appear as a zombie.
    let session: CDPSession | null = null;
    try {
      const CDP_PING_TIMEOUT = 800;
      const withTimeout = <T>(p: Promise<T>): Promise<T> =>
        Promise.race([
          p,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("CDP ping timeout")), CDP_PING_TIMEOUT)
          ),
        ]);
      session = await withTimeout(browser.newBrowserCDPSession());
      await withTimeout(session.send("Browser.getVersion" as any));
      this.lastPingMs = Date.now();
      return true;
    } catch {
      return false;
    } finally {
      if (session) await session.detach().catch(() => {});
    }
  }
}

export const browserManager = new BrowserManager();

/**
 * Semaphore — limits concurrent Playwright pages to avoid overwhelming Chromium.
 * Opening 27 pages at once (9 scrapers × 3 sports) causes timeouts and crashes.
 */
class Semaphore {
  private count = 0;
  constructor(private readonly max: number) {}

  async acquire(timeoutMs: number = 45_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.count >= this.max) {
      if (Date.now() >= deadline) {
        // Holder likely died without releasing — force unblock to prevent deadlock.
        this.count = Math.max(0, this.count - 1);
        throw new Error(`Semaphore deadlock: acquire() blocked for ${timeoutMs}ms`);
      }
      await new Promise<void>((r) => setTimeout(r, 300));
    }
    this.count++;
  }

  release(): void {
    this.count--;
  }
}

export const pageSemaphore = new Semaphore(1); // 1 page at a time — VPS has limited RAM

/** Log current page URL + title — call when a scraper finds 0 events to diagnose wrong URL / redirect */
export async function logPageState(page: Page, scraperName: string, apiCalls?: string[]): Promise<void> {
  try {
    const url = page.url();
    const title = await page.title();
    console.warn(`[${scraperName}] ⚠️  0 events — URL: ${url} | Title: ${title}`);
    if (apiCalls && apiCalls.length > 0) {
      const filtered = apiCalls
        .filter((u) => !u.includes("google") && !u.includes("cloudflare") && !u.includes("analytics"))
        .slice(0, 8);
      if (filtered.length > 0) console.warn(`[${scraperName}]   API calls: ${filtered.join(" | ")}`);
    }
  } catch { /* ignore */ }
}

/**
 * Attach a listener that collects all JSON XHR/fetch response URLs during page load.
 * Returns a getter function — call it after the page has loaded to get the captured URLs.
 * Use these URLs to identify the correct API endpoints to intercept.
 */
export function captureJsonRequests(page: Page): () => string[] {
  const urls: string[] = [];
  page.on("response", (res: any) => {
    const ct: string = res.headers()?.["content-type"] ?? "";
    if (ct.includes("json") && res.status() === 200) urls.push(res.url());
  });
  return () => [...urls];
}

/** Dismiss common cookie/GDPR banners */
export async function dismissCookies(page: Page): Promise<void> {
  const selectors = [
    "button#onetrust-accept-btn-handler",
    "button[data-testid='accept-all']",
    "button.accept-cookies",
    "button[class*='accept']",
    "button[id*='accept']",
    "button[class*='cookie']",
    "#cookieConsentAccept",
    ".cookie-accept",
    "[data-cy='accept-all-cookies']",
    "button:has-text('Aceptar todo')",
    "button:has-text('Aceptar')",
    "button:has-text('Accept all')",
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click();
        await page.waitForTimeout(800);
        return;
      }
    } catch { /* not found, try next */ }
  }
}

/**
 * Returns the residential proxy config for scrapers blocked by datacenter IP.
 * Returns undefined when RESIDENTIAL_PROXY_URL is not set (scraper runs direct).
 * @deprecated Use getProxyForScraper(name) for per-scraper routing (Phase 3).
 */
export function getResidentialProxy(): { server: string; username?: string; password?: string } | undefined {
  if (!config.residentialProxy.enabled) return undefined;
  const { url, username, password } = config.residentialProxy;
  return { server: url, ...(username ? { username, password } : {}) };
}

/**
 * Per-scraper proxy routing (Phase 3).
 * Reads XXXX_PROXY_URL from config.scraperProxies; returns undefined for direct scrapers.
 * Q2 fix: parses credentials out of the URL (Chromium rejects embedded creds in the server field).
 */
export function getProxyForScraper(name: keyof typeof config.scraperProxies): { server: string; username?: string; password?: string } | undefined {
  const rawUrl = config.scraperProxies[name];
  if (!rawUrl) return undefined;
  return parseProxyUrl(rawUrl);
}

// ─── Phase 4: Dead Letter Queue ───────────────────────────────────────────────

const FAILED_PAYLOAD_DIR = path.join(process.cwd(), "logs", "failed_payloads");

/**
 * Saves unexpected API payloads to disk for post-mortem analysis.
 * Called when a scraper receives a response but parses 0 events.
 * Files: logs/failed_payloads/YYYY-MM-DD_HH-MM-SS_casa_sport_tag.json
 */
export function saveFailedPayload(scraperName: string, sport: string, errorTag: string, data: unknown): void {
  try {
    fs.mkdirSync(FAILED_PAYLOAD_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
    const tag = errorTag.slice(0, 30).replace(/[^a-z0-9_-]/gi, "_");
    const raw = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    const ext = raw.trimStart().startsWith("<") ? "html" : "json";
    const fname = `${ts}_${scraperName}_${sport}_${tag}.${ext}`;
    fs.writeFileSync(path.join(FAILED_PAYLOAD_DIR, fname), raw.slice(0, 300_000), "utf-8");
  } catch { /* never throw from dead letter queue */ }
}

/** Extract numeric odds from text, returns null if not a valid decimal odds value */
export function parseOdds(text: string): number | null {
  const cleaned = text.replace(",", ".").trim();
  const val = parseFloat(cleaned);
  if (isNaN(val) || val < 1.01 || val > 1000) return null;
  return val;
}
