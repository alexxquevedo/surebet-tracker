/**
 * FidesBot Scanner — Main orchestrator
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
// Load .env from scraper/ regardless of where node is invoked from
dotenv.config({ path: path.join(__dirname, "../.env") });
import { config } from "./config";
import prisma from "./db";
import { healthUpdate, healthReport } from "./health/checker";
import { findArbs } from "./calculator";
import { notifyArbs } from "./notifier";
import type { ScrapedEvent, GroupedMarket, Sport, MarketOutcomes } from "./types";
import { BaseScraper } from "./scrapers/base";
import { isScraperEnabled } from "./scrapers/scraperState";
import { BetfairScraper } from "./scrapers/betfair";
// MarathonbetScraper disabled: marathonbet.es/es/ only offers casino in Spain (exited sportsbook market)
import { WinamaxScraper } from "./scrapers/winamax";
import { BwinScraper } from "./scrapers/bwin";
import { BetssonScraper } from "./scrapers/betsson";
import { CodereScraper } from "./scrapers/codere";
import { SportiumScraper } from "./scrapers/sportium";
import { WilliamHillScraper } from "./scrapers/williamhill";
import { DaznBetScraper } from "./scrapers/daznbet";
import { PokerStarsScraper } from "./scrapers/pokerstars";
import { Bet365Scraper } from "./scrapers/bet365";
import { OddsApiScraper } from "./scrapers/oddsapi";
import { KambiScraper } from "./scrapers/kambi";
import { AltenarScraper } from "./scrapers/altenar";
import { RetabetScraper } from "./scrapers/retabet";

// ─── Scraper registry ─────────────────────────────────────────────────────────

const scrapers: BaseScraper[] = [
  new OddsApiScraper(),    // Bet365, Betsson, Bwin, WilliamHill, Betfair, Unibet via The Odds API
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
        sport: e.sport,
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
      sport: arb.sport,
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
      isLive: true,
      market: true,
      outcomes: true,
    },
  });

  // Group by eventKey + market
  const groupMap = new Map<string, GroupedMarket>();

  for (const row of rows) {
    if (row.market !== "h2h" && row.market !== "totals") continue;

    const key = `${row.eventKey}::${row.market}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        eventKey: row.eventKey,
        eventName: row.eventName,
        sport: row.sport as Sport,
        isLive: row.isLive,
        market: row.market,
        byBook: new Map(),
      });
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
const WORKING_SCRAPERS = ["betsson", "winamax", "codere", "oddsapi"]; // never use proxy
let zeroCyclesLive = 0;
let zeroCyclesPrematch = 0;
// Rate-limit critical alerts: only send once per 30 min per mode to avoid spam
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
let lastAlertLive = 0;
let lastAlertPrematch = 0;

function isProxyIssue(resultsMap: Map<string, number>): boolean {
  // If ANY working scraper has events, the scanner core is fine — proxy issue only
  return WORKING_SCRAPERS.some((name) => (resultsMap.get(name) ?? 0) > 0);
}

// ─── Main poll cycle ──────────────────────────────────────────────────────────

async function pollCycle(isLive: boolean): Promise<void> {
  const label = isLive ? "LIVE" : "PREMATCH";

  // 1. Scrape all bookmakers in parallel — each isolated, health-tracked
  const scrapeResults = await Promise.allSettled(
    scrapers.filter(s => {
      if (isScraperEnabled(s.name)) return true;
      console.log("[orchestrator] scraper desactivado");
      return false;
    }).map(async (s) => {
      try {
        const events = await (isLive ? s.scrapeLive() : s.scrapePrematch());
        healthUpdate(s.name, isLive, events.length);
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

  // Zero-cycle detection: track consecutive cycles with 0 total events
  if (!allEvents.length) {
    const counter = isLive ? ++zeroCyclesLive : ++zeroCyclesPrematch;
    console.log(`[orchestrator] ${label}: no events scraped (ciclo #${counter} en cero)`);

    if (counter >= 2 && !isProxyIssue(resultsMap)) {
      // Two consecutive all-zero cycles AND working scrapers are also 0 → real outage
      const lastAlert = isLive ? lastAlertLive : lastAlertPrematch;
      const now = Date.now();
      if (now - lastAlert >= ALERT_COOLDOWN_MS) {
        const msg = `🚨 <b>CRITICAL — FidesBot Scanner</b>\n\n` +
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

  // Reset counter on success; send recovery alert if we had sent a critical one
  const wasDown = isLive ? lastAlertLive > 0 : lastAlertPrematch > 0;
  if (isLive) { zeroCyclesLive = 0; lastAlertLive = 0; }
  else { zeroCyclesPrematch = 0; lastAlertPrematch = 0; }
  if (wasDown) {
    await sendAdminAlert(`✅ <b>Recuperado — FidesBot Scanner</b>\n\n${label} vuelve a recibir eventos.`);
  }

  // 2. Persist odds to DB
  await saveOdds(allEvents);
  console.log(`[orchestrator] ${label}: saved ${allEvents.length} events total`);

  // 3. Load grouped markets and detect arbs
  const markets = await loadGroupedMarkets(isLive);
  const arbs = findArbs(markets, config.scanner.minProfitPct);

  if (!arbs.length) {
    console.log(`[orchestrator] ${label}: no arbs found`);
    return;
  }

  console.log(`[orchestrator] ${label}: found ${arbs.length} arbs!`);

  // 4. Save new arbs to DB (parallel — each create is independent)
  const savedArbs = await Promise.all(
    arbs.map(async (arb) => {
      const dbId = await saveDetectedArb(arb);
      return { dbId, arb };
    }),
  );

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
    liveTimer = setTimeout(runLive, config.scanner.livePollMs);
  }
}

async function runPrematch() {
  try {
    await pollCycle(false);
  } catch (err) {
    console.error("[orchestrator] Prematch cycle error:", err);
  } finally {
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

console.log("[scanner] FidesBot Scanner starting...");
console.log(`[scanner] Live poll: ${config.scanner.livePollMs / 1000}s`);
console.log(`[scanner] Prematch poll: ${config.scanner.prematchPollMs / 1000}s`);
console.log(`[scanner] Min profit: ${config.scanner.minProfitPct}%`);

// Stagger the first runs slightly so they don't hammer the DB simultaneously
runLive();
setTimeout(runPrematch, 5000);
setTimeout(runCleanup, 30 * 60 * 1000); // first cleanup after 30min
