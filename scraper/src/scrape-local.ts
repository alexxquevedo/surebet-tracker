/**
 * FidesBot — Agente Local (Betsson + Sportium)
 *
 * Corre en el PC del usuario (IP residencial) donde Kambi CDN no está bloqueado.
 * Escrapea Betsson y Sportium y guarda los eventos directamente en Supabase.
 * El VPS sigue haciendo arb detection y notificaciones — sin cambios allí.
 *
 * Uso:
 *   npm run scrape:local
 *
 * Requiere .env con DATABASE_URL apuntando a Supabase.
 */

import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.join(__dirname, "../.env") });

import prisma from "./db";
import { BetssonScraper } from "./scrapers/betsson";
import { SportiumScraper } from "./scrapers/sportium";
import type { ScrapedEvent } from "./types";

const LIVE_INTERVAL_MS    = 30_000;   // 30s — igual que el VPS
const PREMATCH_INTERVAL_MS = 5 * 60_000; // 5min

const scrapers = [
  new BetssonScraper(),
  new SportiumScraper(),
];

// ─── DB ───────────────────────────────────────────────────────────────────────

async function saveOdds(events: ScrapedEvent[]): Promise<void> {
  if (!events.length) return;
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
        sport: e.sport as any,
        eventKey: e.eventKey,
        eventName: e.eventName,
        league: e.league ?? null,
        startTime: e.startTime ?? null,
        isLive: e.isLive,
        market: e.market,
        outcomes: e.outcomes as any,
      },
    })
  );
  await prisma.$transaction(ops);
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

async function poll(isLive: boolean): Promise<void> {
  const label = isLive ? "LIVE" : "PREMATCH";
  const start = Date.now();

  const results = await Promise.allSettled(
    scrapers.map(async (s) => {
      try {
        const events = await (isLive ? s.scrapeLive() : s.scrapePrematch());
        console.log(`[${s.name}] ${label}: ${events.length} eventos`);
        return events;
      } catch (err) {
        console.warn(`[${s.name}] ${label} error:`, (err as any)?.message ?? err);
        return [] as ScrapedEvent[];
      }
    })
  );

  const allEvents = results.flatMap((r) =>
    r.status === "fulfilled" ? r.value : []
  );

  if (allEvents.length > 0) {
    await saveOdds(allEvents);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const perBook: string[] = [];
    for (const s of scrapers) {
      const count = allEvents.filter((e) => e.bookmaker === s.name).length;
      if (count > 0) perBook.push(`${s.name}=${count}`);
    }
    console.log(
      `[local-agent] ${label}: ${allEvents.length} eventos guardados en DB (${perBook.join(", ")}) — ${elapsed}s`
    );
  } else {
    console.log(`[local-agent] ${label}: sin eventos`);
  }
}

// ─── Loop ─────────────────────────────────────────────────────────────────────

let liveTimer: NodeJS.Timeout;
let prematchTimer: NodeJS.Timeout;

async function runLive() {
  try {
    await poll(true);
  } catch (err) {
    console.error("[local-agent] Error ciclo live:", err);
  } finally {
    liveTimer = setTimeout(runLive, LIVE_INTERVAL_MS);
  }
}

async function runPrematch() {
  try {
    await poll(false);
  } catch (err) {
    console.error("[local-agent] Error ciclo prematch:", err);
  } finally {
    prematchTimer = setTimeout(runPrematch, PREMATCH_INTERVAL_MS);
  }
}

process.on("SIGINT", async () => {
  console.log("\n[local-agent] Cerrando...");
  clearTimeout(liveTimer);
  clearTimeout(prematchTimer);
  const { browserManager } = await import("./scrapers/playwright-base");
  await browserManager.shutdown();
  await prisma.$disconnect();
  process.exit(0);
});

// ─── Start ────────────────────────────────────────────────────────────────────

console.log("╔════════════════════════════════════════════╗");
console.log("║   FidesBot Local Agent — Betsson+Sportium  ║");
console.log("╚════════════════════════════════════════════╝");
console.log(`[local-agent] Live cada ${LIVE_INTERVAL_MS / 1000}s | Prematch cada ${PREMATCH_INTERVAL_MS / 60000}min`);
console.log("[local-agent] DB:", process.env.DATABASE_URL?.slice(0, 40) + "...");
console.log("");

runLive();
setTimeout(runPrematch, 8_000); // Prematch staggered 8s después del primer live
