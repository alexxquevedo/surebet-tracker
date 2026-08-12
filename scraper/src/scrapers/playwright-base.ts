/**
 * Shared Playwright browser manager — single Chromium instance for all scrapers.
 * Keeps one browser open, creates a fresh context per scrape to isolate cookies/sessions.
 */

import * as fs from "fs";
import * as path from "path";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { config } from "../config";

class BrowserManager {
  private directBrowser: Browser | null = null;
  private proxyBrowser: Browser | null = null;

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
    if (!this.directBrowser?.isConnected()) {
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

  // proxyHint truthy → route through residential proxy browser.
  // Pass result of getProxyForScraper(name) — returns undefined for direct scrapers.
  async newPage(proxyHint?: { server: string; username?: string; password?: string }): Promise<{ page: Page; ctx: BrowserContext }> {
    await pageSemaphore.acquire(); // max 3 concurrent pages
    const browser = proxyHint
      ? await this.getResidentialBrowser(proxyHint)
      : await this.getBrowser();
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      viewport: { width: 1920, height: 1080 },
      extraHTTPHeaders: { "Accept-Language": "es-ES,es;q=0.9,en;q=0.8" },
    });
    // Remove automation fingerprints
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // @ts-ignore
      delete navigator.__proto__.webdriver;
    });
    const page = await ctx.newPage();
    // Wrap ctx.close() to release the semaphore automatically
    const originalClose = ctx.close.bind(ctx);
    ctx.close = async () => {
      try { await originalClose(); } finally { pageSemaphore.release(); }
    };
    return { page, ctx };
  }

  async shutdown(): Promise<void> {
    if (this.directBrowser) { await this.directBrowser.close(); this.directBrowser = null; }
    if (this.proxyBrowser) { await this.proxyBrowser.close(); this.proxyBrowser = null; }
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

  async acquire(): Promise<void> {
    while (this.count >= this.max) {
      await new Promise<void>((r) => setTimeout(r, 300));
    }
    this.count++;
  }

  release(): void {
    this.count--;
  }
}

export const pageSemaphore = new Semaphore(3); // max 3 concurrent browser pages

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
 * With IPRoyal IP-whitelist auth, no username/password is needed.
 */
export function getProxyForScraper(name: keyof typeof config.scraperProxies): { server: string } | undefined {
  const url = config.scraperProxies[name];
  return url ? { server: url } : undefined;
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
