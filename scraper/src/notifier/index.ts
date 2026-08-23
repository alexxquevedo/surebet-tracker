/**
 * Sends Telegram alerts for detected arbs.
 * Reads subscriber list from BotSubscription table and filters by their config.
 */

import axios from "axios";
import { config } from "../config";
import prisma from "../db";
import type { DetectedArb, DetectedSurebet, DetectedMiddle } from "../types";

const TG_API = `https://api.telegram.org/bot${config.telegram.token}`;

async function sendMessage(chatId: string, text: string): Promise<void> {
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    console.warn(`[notifier] Failed to send to ${chatId}:`, err?.message);
  }
}

const SPORT_EMOJI: Record<string, string> = {
  FOOTBALL: "⚽", TENNIS: "🎾", BASKETBALL: "🏀",
  AMERICANFOOTBALL: "🏈", ICEHOCKEY: "🏒", BASEBALL: "⚾", RUGBYLEAGUE: "🏉",
  VOLLEYBALL: "🏐",
};

const MARKET_LABEL: Record<string, string> = {
  h2h: "1X2 / Ganador",
  totals: "Totales",
  player_props: "Props Jugador",
};

function formatSurebet(arb: DetectedSurebet): string {
  const sportEmoji = SPORT_EMOJI[arb.sport] ?? "🏅";
  const liveTag = arb.isLive ? "🔴 LIVE" : "📅 Pre-partido";
  const isProps = arb.market === "player_props";
  const header = isProps
    ? `🏀 <b>PLAYER PROP SUREBET +${arb.profitPct.toFixed(2)}%</b> — ${liveTag}`
    : `🤑 <b>SUREBET +${arb.profitPct.toFixed(2)}%</b> — ${sportEmoji} ${liveTag}`;
  const marketLabel = MARKET_LABEL[arb.market] ?? arb.market;
  const event = `📋 <b>${arb.eventName}</b>\n💹 Mercado: ${marketLabel}`;
  const legs = arb.legs
    .map(
      (l) =>
        `  • <b>${l.bookmaker.toUpperCase()}</b> → ${l.selection} @ <b>${l.odds.toFixed(2)}</b> (${l.stake.toFixed(1)}% de la apuesta)`,
    )
    .join("\n");
  return `${header}\n${event}\n\n${legs}\n\n⚡ Aprovecha antes de que cierre`;
}

function formatMiddle(arb: DetectedMiddle): string {
  const sportEmoji = arb.sport === "FOOTBALL" ? "⚽" : arb.sport === "TENNIS" ? "🎾" : "🏀";
  const liveTag = arb.isLive ? "🔴 LIVE" : "📅 Pre-partido";
  const header = `🎯 <b>MIDDLE +${arb.profitPct.toFixed(2)}%</b> — ${sportEmoji} ${liveTag}`;
  const event = `📋 <b>${arb.eventName}</b>\n💹 Ventana: ${arb.windowLow} — ${arb.windowHigh} goles`;
  const loss = `⚠️ Peor caso (si falla): ${Math.abs(arb.worstLoss).toFixed(2)}%`;
  const legs = arb.legs
    .map(
      (l) =>
        `  • <b>${l.bookmaker.toUpperCase()}</b> → ${l.selection} @ <b>${l.odds.toFixed(2)}</b> (${l.stake.toFixed(1)}%)`,
    )
    .join("\n");
  return `${header}\n${event}\n${loss}\n\n${legs}`;
}

function formatArb(arb: DetectedArb): string {
  return arb.type === "SUREBET"
    ? formatSurebet(arb as DetectedSurebet)
    : formatMiddle(arb as DetectedMiddle);
}

/**
 * Get all active bot subscribers that have the scanner feature enabled.
 * Each subscriber's config JSON may contain a "scanner" key with their preferences.
 */
async function getActiveSubscribers(): Promise<
  Array<{ telegramId: string; config: any }>
> {
  const now = new Date();
  const subs = await prisma.botSubscription.findMany({
    where: {
      OR: [
        { expiresAt: null },          // permanent / admin
        { expiresAt: { gt: now } },   // active subscription
      ],
    },
    select: { telegramId: true, config: true },
  });
  // Only subscribers who have explicitly enabled the scanner
  // If config is null or config.scanner is missing, they haven't set it up yet
  return subs.filter((s: (typeof subs)[0]) => {
    const cfg = s.config as any;
    return cfg?.scanner?.enabled === true || cfg?.scanner?.active === true;
  });
}

/**
 * Check if an arb matches a subscriber's preferences.
 */
function matchesPrefs(arb: DetectedArb, subConfig: any): boolean {
  const sc = subConfig?.scanner ?? {};

  const minProfit = sc.min_profit ?? sc.minProfitPct;
  if (minProfit && arb.profitPct < minProfit) return false;

  if (sc.sports?.length && !sc.sports.includes(arb.sport)) return false;

  // Use === false so that undefined (field absent) is treated as "allow"
  if (sc.alertSurebets === false && arb.type === "SUREBET") return false;
  if (sc.alertMiddles === false && arb.type === "MIDDLE") return false;
  if (sc.alertLive === false && arb.isLive) return false;
  if (sc.alertPrematch === false && !arb.isLive) return false;

  // If subscriber has specified their bookmakers, at least one leg must be from those
  if (sc.bookmakers?.length) {
    const arbBooks = arb.legs.map((l) => l.bookmaker);
    const hasBook = arbBooks.some((b) => sc.bookmakers.includes(b));
    if (!hasBook) return false;
  }

  return true;
}

/**
 * Main notify function — called after each arb detection cycle.
 * Sends alerts to matching subscribers and records them in ArbNotification.
 */
export async function notifyArbs(
  newArbs: Array<{ dbId: string; arb: DetectedArb }>,
): Promise<void> {
  if (!newArbs.length) return;

  const subscribers = await getActiveSubscribers();
  if (!subscribers.length) return;

  for (const { dbId, arb } of newArbs) {
    const message = formatArb(arb);

    for (const sub of subscribers) {
      if (!matchesPrefs(arb, sub.config)) continue;

      // Record first — the unique constraint on (arbId, telegramId) prevents duplicates
      // even under concurrent execution. If the insert fails with P2002, skip.
      try {
        await prisma.arbNotification.create({
          data: { arbId: dbId, telegramId: sub.telegramId },
        });
      } catch (err: any) {
        if (err.code === "P2002") continue; // already notified
        throw err;
      }

      await sendMessage(sub.telegramId, message);
    }
  }
}
