/**
 * FiidesBot Scanner — Main orchestrator
 *
 * Architecture:
 *   1. Every LIVE_POLL_INTERVAL (30s):  scrape live odds → detect arbs → notify
 *   2. Every PREMATCH_POLL_INTERVAL (5min): scrape pre-match → detect arbs → notify
 *   3. Every hour: clean up expired ScannedOdds and old DetectedArbs
 *
 * Deployed on Hetzner VPS (separate from Vercel / Next.js app).
 * Writes to the same PostgreSQL database as the main app.
 */

import dotenv from "dotenv";
import path from "path";
import * as fs from "fs";
// Load .env from scraper/ regardless of where node is invoked from
dotenv.config({ path: path.join(__dirname, "../.env") });
import { config } from "./config";
import prisma from "./db";
import { healthUpdate, healthReport } from "./health/checker";
import { findArbs } from "./calculator";
import { notifyArbs } from "./notifier";
import type { ScrapedEvent, GroupedMarket, Sport, MarketOutcomes, H2HOutcome, DetectedArb } from "./types";
import { BaseScraper } from "./scrapers/base";
import { isScraperEnabled } from "./scrapers/scraperState";
import { BetfairScraper } from "./scrapers/betfair";
// MarathonbetScraper: geo-blocked 451 from both VPS (FR) and Digi 4G ES proxy
import { WinamaxScraper } from "./scrapers/winamax";
import { BwinScraper } from "./scrapers/bwin";
import { BetssonScraper } from "./scrapers/betsson";
import { CodereScraper } from "./scrapers/codere";
import { SportiumScraper } from "./scrapers/sportium";
import { WilliamHillScraper } from "./scrapers/williamhill";
import { DaznBetScraper } from "./scrapers/daznbet";
import { PokerStarsScraper } from "./scrapers/pokerstars";
import { Bet365Scraper } from "./scrapers/bet365";
import { KambiScraper } from "./scrapers/kambi";
import { AltenarScraper } from "./scrapers/altenar";
import { RetabetScraper } from "./scrapers/retabet";
import { isProxyPaused, getPauseInfo, preflightCheck } from "./scrapers/ip-rotator";
import { resetScraperCooldown } from "./scrapers/playwright-base";
import { recordCycle, writeHealthFile } from "./health-file";
import { filterSpikes, getSpikeFilterStats } from "./spike-filter";
import { logger } from "./logger";

// ─── Scraper registry ─────────────────────────────────────────────────────────

const scrapers: BaseScraper[] = [
  new WinamaxScraper(),
  new CodereScraper(),
  new BetfairScraper(),
  new Bet365Scraper(),
  new SportiumScraper(),
  new BwinScraper(),
  new WilliamHillScraper(),
  new BetssonScraper(),
  new DaznBetScraper(),
  new PokerStarsScraper(),
  // Kambi B2B — 4 casas espanolas (requiere KAMBI_PROXY_URL)
  new KambiScraper("leovegas",   "leovegas"),
  new KambiScraper("888sport",   "888sport"),
  new KambiScraper("casumo",     "casumo"),
  new KambiScraper("betsson_es", "betsson"),
  // Kambi ES — Unibet España usa "unibet_spain" como clientId (verificado vía CDN)
  new KambiScraper("unibet",   "unibet_spain"),
  // Kambi ES — smaller bookmakers (client IDs pendientes de verificar con proxy)
  new KambiScraper("marca",    "marcaapuestas"),
  new KambiScraper("kirolbet", "kirolbet"),
  // Altenar B2B — casas espanolas (requiere ALTENAR_PROXY_URL)
  // TonyBet ES está en Altenar (no Kambi). integrationId pendiente de verificar con proxy.
  new AltenarScraper("luckia",           "Luckia"),
  new AltenarScraper("casino-gran-madrid","CasinoGranMadrid"),
  new AltenarScraper("tonybet",          "TonyBet"),
  new RetabetScraper(),
];

// ─── Sport → Prisma enum mapping ─────────────────────────────────────────────
// VPS Prisma SportType: FOOTBALL|TENNIS|BASKETBALL|BASEBALL|HOCKEY|CRICKET|RUGBY|GOLF|MMA|BOXING|OTHER
// Our internal Sport type has more values — map to nearest Prisma equivalent.
const SPORT_TO_PRISMA: Record<string, string> = {
  FOOTBALL:         "FOOTBALL",
  TENNIS:           "TENNIS",
  BASKETBALL:       "BASKETBALL",
  BASEBALL:         "BASEBALL",
  ICEHOCKEY:        "HOCKEY",
  HOCKEY:           "HOCKEY",
  RUGBYLEAGUE:      "RUGBY",
  RUGBY:            "RUGBY",
  AMERICANFOOTBALL: "OTHER",
  VOLLEYBALL:       "OTHER",
  HANDBALL:         "OTHER",
};
function toPrismaSport(sport: string): string {
  return SPORT_TO_PRISMA[sport] ?? "OTHER";
}

// ─── DIAGNOSE mode ───────────────────────────────────────────────────────────
// Run: DIAGNOSE=true node dist/index.js
// Checks env vars + SSH/WireGuard connectivity, prints a report, then exits.
// Never starts the scraping loop.

if (process.env.DIAGNOSE === "true") {
  void (async () => {
    console.log("\n═══════════════════════════════════════");
    console.log("  FiidesBot Scanner — DIAGNOSE MODE");
    console.log("═══════════════════════════════════════\n");

    const required = ["DATABASE_URL", "TELEGRAM_TOKEN"];
    const optional = [
      "ROUTER_SSH_HOST", "ROUTER_SSH_USER", "ROUTER_SSH_KEY",
      "ROUTER_PROXY_URL", "DRY_RUN", "HEALTH_FILE",
    ];

    let allOk = true;
    console.log("[ ENV VARS ]");
    for (const v of required) {
      const ok = !!process.env[v];
      if (!ok) allOk = false;
      console.log(`  ${ok ? "✅" : "❌"} ${v}: ${ok ? "(set)" : "MISSING — required"}`);
    }
    for (const v of optional) {
      const val = process.env[v];
      console.log(`  ${val ? "✅" : "➖"} ${v}: ${val ? `"${val.slice(0, 40)}"` : "(not set)"}`);
    }

    console.log("\n[ WireGuard / SSH ]");
    const hasRouter = !!(process.env.ROUTER_SSH_HOST || process.env.ROUTER_PROXY_URL);
    if (!hasRouter) {
      console.log("  ➖ Router not configured — skipping preflight (direct scrapers only)");
    } else {
      const pf = await preflightCheck();
      console.log(`  ${pf.ok ? "✅" : "❌"} WireGuard: ${pf.wgStatus}${pf.wgLatencyMs != null ? ` (${pf.wgLatencyMs}ms)` : ""}`);
      if (!pf.ok) allOk = false;
    }

    console.log("\n[ DB ]");
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log("  ✅ PostgreSQL: connected");
    } catch (e: any) {
      console.log(`  ❌ PostgreSQL: ${String(e?.message ?? e).slice(0, 80)}`);
      allOk = false;
    }

    console.log("\n[ SCRAPERS ]");
    const proxyScrapers = scrapers.filter(s => (s as any).proxyUrl || (s as any).requiresProxy);
    const directScrapers = scrapers.filter(s => !proxyScrapers.includes(s));
    console.log(`  Direct:  ${directScrapers.map(s => s.name).join(", ") || "(none)"}`);
    console.log(`  Proxy:   ${proxyScrapers.map(s => s.name).join(", ") || "(none)"}`);
    console.log(`  Total:   ${scrapers.length}`);

    console.log(`\n═══════════════════════════════════════`);
    console.log(`  Result: ${allOk ? "✅ READY TO RUN" : "❌ FIX ISSUES ABOVE"}`);
    console.log(`═══════════════════════════════════════\n`);

    await prisma.$disconnect();
    process.exit(allOk ? 0 : 1);
  })();
} else {

// ─── DRY_RUN mock data ────────────────────────────────────────────────────────
// Injects fake events with guaranteed-arb odds so the full pipeline runs without
// real HTTP requests. Enable with DRY_RUN=true in .env.

const DRY_RUN = process.env.DRY_RUN === "true";

if (DRY_RUN) {
  console.warn("[scanner] ⚠️  DRY_RUN=true — no real HTTP requests will be made");
}

function mockEvents(scraperName: string, isLive: boolean): ScrapedEvent[] {
  const startTime = new Date(Date.now() + 60 * 60 * 1000);
  const oddsMap = scraperName === "winamax"
    ? { "Real Madrid": 2.50, "Draw": 4.20, "Barcelona": 2.70 }
    : { "Real Madrid": 2.10, "Draw": 4.10, "Barcelona": 3.10 };
  const outcomes: H2HOutcome[] = Object.entries(oddsMap).map(([name, odds]) => ({ name, odds }));
  return [{
    bookmaker: scraperName,
    sport: "FOOTBALL" as Sport,
    eventKey: `dry-run-real-madrid-barcelona:${new Date().toISOString().slice(0, 10)}`,
    eventName: "[DRY_RUN] Real Madrid - Barcelona",
    league: "LaLiga",
    isLive,
    startTime,
    market: "h2h",
    outcomes,
  }];
}

// ─── Arb deduplication (in-memory) ───────────────────────────────────────────
// Prevents re-saving and re-notifying the same logical arb every 30s cycle.
// Keyed by a fingerprint of (type, eventName, market, legs). Expires after ARB_DEDUP_MS.
const arbDedup = new Map<string, number>();
const ARB_DEDUP_MS = 10 * 60 * 1000;

function arbFingerprint(arb: DetectedArb): string {
  const legs = arb.legs.map((l) => `${l.bookmaker}:${l.selection}`).sort().join("|");
  return `${arb.type}::${arb.eventKey}::${arb.market}::${legs}`;
}

// ─── DB persistence ───────────────────────────────────────────────────────────

async function saveOdds(events: ScrapedEvent[]): Promise<void> {
  if (!events.length) return;

  // Upsert all scraped odds (replace outdated odds for same book+event+market)
  const ops = events.map((e) =>
    prisma.scannedOdds.upsert({
      where: {
        bookmaker_eventKey_market: {
          bookmaker: e.bookmaker,
          eventKey: e.eventKey,
          market: e.market,
        },
      },
      update: {
        outcomes: e.outcomes as any,
        eventName: e.eventName,
        league: e.league ?? null,
        startTime: e.startTime ?? null,
        isLive: e.isLive,
        scrapedAt: new Date(),
      },
      create: {
        bookmaker: e.bookmaker,
        sport: toPrismaSport(e.sport) as any,
        eventKey: e.eventKey,
        eventName: e.eventName,
        league: e.league ?? null,
        startTime: e.startTime ?? null,
        isLive: e.isLive,
        market: e.market,
        outcomes: e.outcomes as any,
      },
    }),
  );

  await prisma.$transaction(ops);
}

async function saveDetectedArb(
  arb: import("./types").DetectedArb,
): Promise<string> {
  const record = await prisma.detectedArb.create({
    data: {
      type: arb.type,
      sport: toPrismaSport(arb.sport) as any,
      isLive: arb.isLive,
      eventName: arb.eventName,
      market: arb.market,
      profitPct: arb.profitPct,
      worstLoss: arb.type === "MIDDLE" ? (arb as any).worstLoss : null,
      legs: {
        create: arb.legs.map((l) => ({
          bookmaker: l.bookmaker,
          selection: l.selection,
          odds: l.odds,
          stake: l.stake,
          url: l.url ?? null,
        })),
      },
    },
  });
  return record.id;
}

// ─── Grouping ──────────────────────────────────────────────────────────────────

/**
 * Read fresh ScannedOdds from DB, group by (eventKey, market) across all bookmakers.
 * Only includes events scraped in the last 10 minutes.
 */
async function loadGroupedMarkets(liveOnly?: boolean): Promise<GroupedMarket[]> {
  const since = new Date(Date.now() - config.scanner.oddsExpiryMs);

  const rows = await prisma.scannedOdds.findMany({
    where: {
      scrapedAt: { gte: since },
      ...(liveOnly !== undefined ? { isLive: liveOnly } : {}),
    },
    select: {
      bookmaker: true,
      sport: true,
      eventKey: true,
      eventName: true,
      league: true,
      isLive: true,
      startTime: true,
      market: true,
      outcomes: true,
    },
  });

  // Group by eventKey + market.
  // Normalize eventKey by stripping the trailing date (:YYYY-MM-DD or :nodate) before grouping
  // so that Codere (has real dates) and Winamax (has :nodate from WS) can be matched.
  const groupMap = new Map<string, GroupedMarket>();
  const DATE_SUFFIX = /:[0-9]{4}-[0-9]{2}-[0-9]{2}$|:nodate$/;

  for (const row of rows) {
    const normalizedKey = row.eventKey.replace(DATE_SUFFIX, "");
    // Include isLive in the key so live odds from one book never merge with prematch odds from
    // another — prevents false arbs when one book still has stale prematch lines for a live event.
    const key = `${normalizedKey}::${row.market}::${row.isLive ? "live" : "pre"}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        eventKey: row.eventKey,
        eventName: row.eventName,
        league: row.league ?? undefined,
        sport: row.sport as unknown as Sport,
        isLive: row.isLive,
        startTime: row.startTime ?? undefined,
        market: row.market,
        byBook: new Map(),
      });
    } else {
      const existing = groupMap.get(key)!;
      // Prefer real-date eventKey over :nodate
      if (existing.eventKey.endsWith(":nodate") && !row.eventKey.endsWith(":nodate")) {
        existing.eventKey = row.eventKey;
      }
      // Prefer non-null startTime
      if (!existing.startTime && row.startTime) {
        existing.startTime = row.startTime;
      }
      // Prefer non-null league from any bookmaker in the group
      if (!existing.league && row.league) {
        existing.league = row.league;
      }
    }
    groupMap.get(key)!.byBook.set(row.bookmaker, row.outcomes as unknown as MarketOutcomes);
  }

  // Only markets with at least 2 bookmakers have arb potential
  return [...groupMap.values()].filter((g) => g.byBook.size >= 2);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  const cutoff = new Date(Date.now() - config.scanner.oddsExpiryMs);
  const arbCutoff = new Date(Date.now() - config.scanner.arbRetentionMs);

  const [odds, arbs] = await prisma.$transaction([
    prisma.scannedOdds.deleteMany({ where: { scrapedAt: { lt: cutoff } } }),
    prisma.detectedArb.deleteMany({ where: { detectedAt: { lt: arbCutoff } } }),
  ]);

  if (odds.count || arbs.count) {
    console.log(`[cleanup] Removed ${odds.count} old odds, ${arbs.count} old arbs`);
  }
}

// ─── Admin alerting ───────────────────────────────────────────────────────────

const ADMIN_CHAT_IDS = ["1207554638", "2051653218"];

async function sendAdminAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return;
  for (const chatId of ADMIN_CHAT_IDS) {
    try {
      const { default: axios } = await import("axios");
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      });
    } catch (err: any) {
      console.warn(`[admin-alert] Failed to send to ${chatId}:`, err?.message);
    }
  }
}

// ─── Zero-cycle tracking ──────────────────────────────────────────────────────

// Track consecutive cycles where ALL scrapers return 0 events.
// Proxy 402 heuristic: if working scrapers (Betsson, Winamax, Codere) still have events
// but proxy-dependent ones return 0, that's a proxy issue — no alert needed.
const WORKING_SCRAPERS = ["winamax", "codere"]; // never use proxy
let zeroCyclesLive = 0;
let zeroCyclesPrematch = 0;
// Rate-limit alerts: only send once per 30 min per mode to avoid spam
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
let lastAlertLive = 0;
let lastAlertPrematch = 0;
let lastRecoveredLive = 0;
let lastRecoveredPrematch = 0;

function isProxyIssue(resultsMap: Map<string, number>): boolean {
  // If ANY working scraper has events, the scanner core is fine — proxy issue only
  return WORKING_SCRAPERS.some((name) => (resultsMap.get(name) ?? 0) > 0);
}

// ─── Proxy concurrency limiter ───────────────────────────────────────────────────
// Prevents saturating the single WireGuard SOCKS5 tunnel with simultaneous Axios requests.
// Playwright-based scrapers (bwin, pokerstars) are NOT throttled here — they have their own
// pageSemaphore and use persistent connections rather than many short-lived HTTP requests.
class ProxySemaphore {
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.max) {
      await new Promise<void>(r => setTimeout(r, 250));
    }
    this.active++;
    try { return await fn(); } finally { this.active--; }
  }
}
const proxySemaphore = new ProxySemaphore(3);

// Axios-based scrapers that route through the SOCKS5 proxy — throttled by proxySemaphore
const PROXY_THROTTLED_AXIOS = new Set([
  "williamhill", "betsson",
  // Kambi B2B — each instance serializes its sports internally, so 1 connection at a time per scraper
  "leovegas", "888sport", "casumo", "betsson_es", "unibet", "marca", "kirolbet",
  // Altenar
  "luckia", "casino-gran-madrid", "tonybet",
  "retabet",
]);

// ─── Main poll cycle ──────────────────────────────────────────────────────────

async function pollCycle(isLive: boolean): Promise<void> {
  const label = isLive ? "LIVE" : "PREMATCH";

  // 1. Pre-flight: check WireGuard tunnel before wasting a cycle on proxy scrapers
  const preflight = await preflightCheck();
  const proxyPaused = isProxyPaused();

  if (proxyPaused) {
    const info = getPauseInfo();
    logger.warn("orchestrator.proxy_pause_active", { pauseUntil: info?.until.toISOString(), remainingMs: info?.remainingMs });
  }

  // scraperProxies keys: all proxy-dependent scrapers; direct scrapers (winamax, codere, betfair) are absent
  const proxyScrapers = new Set(Object.keys(config.scraperProxies).filter(k => (config.scraperProxies as Record<string, string>)[k]));

  const SCRAPER_TIMEOUT_MS = isLive ? 60 * 1000 : 10 * 60 * 1000; // 60s live, 10min prematch
  // Browser-based scrapers (Playwright) block the pageSemaphore and always return 0 live events
  // Kambi CDN (eu-offering.kambicdn.org) blocks our IP at TCP level — skip until new proxy
  // Altenar also blocked. Retabet blocked by Akamai.
  const KAMBI_BLOCKED = new Set(["leovegas", "888sport", "casumo", "betsson_es", "unibet", "marca", "kirolbet"]);
  const ALTENAR_BLOCKED = new Set(["luckia", "casino-gran-madrid", "tonybet"]);
  const skipInLive = new Set(["bet365", "sportium", "marathonbet", "retabet", ...KAMBI_BLOCKED, ...ALTENAR_BLOCKED]);
  // Prematch scrapers that return 0 events but hold pageSemaphore, blocking DaznBet
  const skipInPrematch = new Set([...KAMBI_BLOCKED, ...ALTENAR_BLOCKED, "retabet", "bet365", "sportium", "marathonbet"]); // never produce prematch events, block the cycle for full timeout
  const scrapeResults = await Promise.allSettled(
    scrapers.filter(s => {
      if (!isScraperEnabled(s.name)) {
        console.log("[orchestrator] scraper desactivado");
        return false;
      }
      if (isLive && skipInLive.has(s.name)) { logger.warn("orchestrator.scraper_skipped_live_browser", { bookmaker: s.name }); return false; }
      if (!isLive && skipInPrematch.has(s.name)) { logger.warn("orchestrator.scraper_skipped_prematch_0ev", { bookmaker: s.name }); return false; }
      const usesProxy = proxyScrapers.has(s.name) || PROXY_THROTTLED_AXIOS.has(s.name);
      if (usesProxy) {
        if (proxyPaused) { logger.warn("orchestrator.scraper_skipped_pause", { bookmaker: s.name }); return false; }
        if (!preflight.ok) { logger.warn("orchestrator.scraper_skipped_wg_down", { bookmaker: s.name }); return false; }
      }
      return true;
    }).map(async (s) => {
      try {
        const scraperTimeout = s.name === "daznbet" && isLive ? 220 * 1000 : SCRAPER_TIMEOUT_MS;
        const timeoutPromise = new Promise<ScrapedEvent[]>((_, reject) =>
          setTimeout(() => reject(new Error(`Scraper timeout: ${s.name} exceeded ${scraperTimeout}ms`)), scraperTimeout)
        );
        const scrapePromise = DRY_RUN
          ? Promise.resolve(mockEvents(s.name, isLive))
          : PROXY_THROTTLED_AXIOS.has(s.name)
            ? proxySemaphore.run(() => (isLive ? s.scrapeLive() : s.scrapePrematch()))
            : (isLive ? s.scrapeLive() : s.scrapePrematch());
        const events = await Promise.race([scrapePromise, timeoutPromise]);
        healthUpdate(s.name, isLive, events.length);
        // Reset exponential backoff counter on success
        if (events.length > 0) resetScraperCooldown(s.name);
        return { name: s.name, events };
      } catch (err) {
        healthUpdate(s.name, isLive, 0);
        console.warn(`[orchestrator] ${s.name} threw:`, err);
        return { name: s.name, events: [] as ScrapedEvent[] };
      }
    }),
  );

  const allEvents: ScrapedEvent[] = [];
  const perBook: string[] = [];
  const resultsMap = new Map<string, number>();
  for (const result of scrapeResults) {
    if (result.status === "fulfilled") {
      allEvents.push(...result.value.events);
      resultsMap.set(result.value.name, result.value.events.length);
      if (result.value.events.length > 0) perBook.push(`${result.value.name}=${result.value.events.length}`);
    } else {
      console.warn(`[orchestrator] Scraper promise rejected:`, result.reason);
    }
  }

  if (perBook.length > 0) {
    console.log(`[orchestrator] ${label}: ${perBook.join(", ")}`);
  }

  // Record cycle stats for health file (always, even on zero-event cycles)
  recordCycle(isLive, allEvents.length);

  // Zero-cycle detection: track consecutive cycles with 0 total events
  if (!allEvents.length) {
    const counter = isLive ? ++zeroCyclesLive : ++zeroCyclesPrematch;
    console.log(`[orchestrator] ${label}: no events scraped (ciclo #${counter} en cero)`);

    if (counter >= 2 && !isProxyIssue(resultsMap)) {
      // Two consecutive all-zero cycles AND working scrapers are also 0 → real outage
      const lastAlert = isLive ? lastAlertLive : lastAlertPrematch;
      const now = Date.now();
      if (now - lastAlert >= ALERT_COOLDOWN_MS) {
        const msg = `🚨 <b>CRITICAL — FiidesBot Scanner</b>\n\n` +
          `${label} llevan ${counter} ciclos sin eventos en NINGUNA casa.\n` +
          `Scrapers activos: ${[...resultsMap.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "ninguno"}\n\n` +
          `Revisar VPS: <code>pm2 logs fidesbot-scanner --lines 50</code>`;
        await sendAdminAlert(msg);
        if (isLive) lastAlertLive = now;
        else lastAlertPrematch = now;
      }
    }
    return;
  }

  // Reset counter on success; send recovery alert if we had sent a critical one.
  // IMPORTANT: do NOT reset lastAlert to 0 on recovery — that removes the 30-min cooldown
  // and causes a CRITICAL/RECOVERED spam loop. Instead, bump it to now so the next CRITICAL
  // can only fire after another full ALERT_COOLDOWN_MS window.
  const wasDown = isLive ? lastAlertLive > 0 : lastAlertPrematch > 0;
  if (isLive) { zeroCyclesLive = 0; if (wasDown) lastAlertLive = Date.now(); }
  else { zeroCyclesPrematch = 0; if (wasDown) lastAlertPrematch = Date.now(); }
  if (wasDown) {
    const lastRec = isLive ? lastRecoveredLive : lastRecoveredPrematch;
    if (Date.now() - lastRec >= ALERT_COOLDOWN_MS) {
      await sendAdminAlert(`✅ <b>Recuperado — FiidesBot Scanner</b>\n\n${label} vuelve a recibir eventos.`);
      if (isLive) lastRecoveredLive = Date.now();
      else lastRecoveredPrematch = Date.now();
    }
  }

  // 2. Spike filter — hold back anomalous odds for one cycle before saving
  const filteredEvents = filterSpikes(allEvents);
  const spikeStats = getSpikeFilterStats();
  if (spikeStats.pendingCount > 0) {
    logger.warn("spike_filter.pending", { ...spikeStats, held: allEvents.length - filteredEvents.length });
  }

  // 3. Persist confirmed odds to DB
  await saveOdds(filteredEvents);
  console.log(`[orchestrator] ${label}: saved ${filteredEvents.length} events (${allEvents.length - filteredEvents.length} held for spike confirmation)`);

  // 4. Load grouped markets and detect arbs
  const markets = await loadGroupedMarkets(isLive);
  const arbs = findArbs(markets, config.scanner.minProfitPct);

  if (!arbs.length) {
    console.log(`[orchestrator] ${label}: no arbs found`);
    return;
  }

  // Deduplicate: prune expired entries then filter out recently-seen arbs
  const now = Date.now();
  for (const [fp, ts] of arbDedup) {
    if (now - ts > ARB_DEDUP_MS) arbDedup.delete(fp);
  }
  const newArbs = arbs.filter((arb) => {
    const fp = arbFingerprint(arb);
    if (arbDedup.has(fp)) return false;
    arbDedup.set(fp, now);
    return true;
  });

  console.log(`[orchestrator] ${label}: found ${arbs.length} arbs! (${newArbs.length} new)`);

  if (!newArbs.length) return;

  // 4. Save new arbs to DB (sequential to avoid exhausting the connection pool)
  const savedArbs: Array<{ dbId: string; arb: DetectedArb }> = [];
  for (const arb of newArbs) {
    try {
      const dbId = await saveDetectedArb(arb);
      savedArbs.push({ dbId, arb });
    } catch (err: any) {
      console.warn(`[orchestrator] Failed to save arb for ${arb.eventName}:`, err?.message);
    }
  }

  // 5. Notify subscribers
  await notifyArbs(savedArbs);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

let liveTimer: NodeJS.Timeout;
let prematchTimer: NodeJS.Timeout;
let cleanupTimer: NodeJS.Timeout;

async function runLive() {
  try {
    await pollCycle(true);
  } catch (err) {
    console.error("[orchestrator] Live cycle error:", err);
  } finally {
    writeHealthFile();
    liveTimer = setTimeout(runLive, config.scanner.livePollMs);
  }
}

async function runPrematch() {
  try {
    await pollCycle(false);
  } catch (err) {
    console.error("[orchestrator] Prematch cycle error:", err);
  } finally {
    writeHealthFile();
    prematchTimer = setTimeout(runPrematch, config.scanner.prematchPollMs);
  }
}

async function runCleanup() {
  try {
    await cleanup();
    const report = healthReport();
    const dead = Object.entries(report).filter(([, r]) => r.status === "DEAD").map(([k]) => k);
    if (dead.length > 0) {
      console.warn(`[health] Dead scrapers: ${dead.join(", ")}`);
    } else {
      console.log(`[health] All scrapers healthy`);
    }
  } catch (err) {
    console.error("[orchestrator] Cleanup error:", err);
  } finally {
    cleanupTimer = setTimeout(runCleanup, 60 * 60 * 1000); // every hour
  }
}

process.on("SIGTERM", async () => {
  console.log("[scanner] SIGTERM received — shutting down...");
  clearTimeout(liveTimer);
  clearTimeout(prematchTimer);
  clearTimeout(cleanupTimer);
  const { browserManager } = await import("./scrapers/playwright-base");
  await browserManager.shutdown();
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("\n[scanner] Shutting down...");
  clearTimeout(liveTimer);
  clearTimeout(prematchTimer);
  clearTimeout(cleanupTimer);
  const { browserManager } = await import("./scrapers/playwright-base");
  await browserManager.shutdown();
  await prisma.$disconnect();
  process.exit(0);
});

// Clean up stale Playwright profile dirs left by previous crashes
try {
  const stale = fs.readdirSync("/tmp").filter(e => e.startsWith("playwright_chromiumdev_profile-"));
  for (const dir of stale) fs.rmSync(path.join("/tmp", dir), { recursive: true, force: true });
  if (stale.length > 0) console.log(`[scanner] Cleaned ${stale.length} stale Playwright dirs`);
} catch { /* non-fatal */ }

console.log("[scanner] FiidesBot Scanner starting...");
console.log(`[scanner] Live poll: ${config.scanner.livePollMs / 1000}s`);
console.log(`[scanner] Prematch poll: ${config.scanner.prematchPollMs / 1000}s`);
console.log(`[scanner] Min profit: ${config.scanner.minProfitPct}%`);

// Stagger the first runs slightly so they don't hammer the DB simultaneously
runLive();
setTimeout(runPrematch, 5000);
setTimeout(runCleanup, 30 * 60 * 1000); // first cleanup after 30min

} // end DIAGNOSE else block
