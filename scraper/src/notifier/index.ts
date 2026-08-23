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
  VOLLEYBALL: "🏐", RUGBY: "🏉", HOCKEY: "🏒", HANDBALL: "🤾",
};

const SPORT_LABEL: Record<string, string> = {
  FOOTBALL: "Fútbol", TENNIS: "Tenis", BASKETBALL: "Baloncesto",
  AMERICANFOOTBALL: "Fútbol Americano", ICEHOCKEY: "Hockey Hielo",
  BASEBALL: "Béisbol", RUGBYLEAGUE: "Rugby", VOLLEYBALL: "Vóleibol",
  RUGBY: "Rugby", HOCKEY: "Hockey", HANDBALL: "Balonmano",
};

const MARKET_LABEL: Record<string, string> = {
  h2h: "1X2 / Ganador",
  handicap: "Hándicap",
  totals: "Total",
  player_props: "Prop Jugador",
  goals: "Total Goles",
  h1_goals: "Goles 1ª Parte",
  h2_goals: "Goles 2ª Parte",
  corners: "Córners",
  yellow_cards: "Tarjetas Amarillas",
  red_cards: "Tarjetas Rojas",
  cards: "Tarjetas Totales",
  btts: "Ambos Marcan",
  shots: "Tiros a Puerta",
  games: "Juegos",
  sets: "Sets",
  aces: "Aces",
  double_faults: "Dobles Faltas",
  match_points: "Puntos",
  home_runs: "Jonrones",
  runs: "Carreras",
  tries: "Ensayos",
  touchdowns: "Touchdowns",
};

// Stat code → Spanish description for player props
const STAT_LABEL: Record<string, string> = {
  PRA: "puntos + asistencias + rebotes",
  PTS: "puntos",
  REB: "rebotes",
  AST: "asistencias",
  "3PT": "triples",
  shots: "tiros",
  goals: "goles",
  passes: "pases",
  tackles: "entradas",
  corners_taken: "córners",
  cards: "tarjetas",
  aces: "aces",
  double_faults: "dobles faltas",
  first_serve_pct: "% primer saque",
  games: "juegos",
  hits: "hits",
  runs_batted_in: "carreras impulsadas",
  strikeouts: "ponches",
  home_runs: "jonrones",
  tries: "ensayos",
  conversions: "conversiones",
  points: "puntos",
  rebounds: "rebotes",
  assists: "asistencias",
};

// Translates a stat abbreviation at the END of a player prop selection string.
// e.g. "Julian Champagnie +19.5 PRA" → "Julian Champagnie +19.5 puntos + asistencias + rebotes"
function translateSelection(selection: string): string {
  return selection.replace(/\b([A-Za-z0-9_]+)$/, (_, stat) => STAT_LABEL[stat] ?? stat);
}

function formatDatetime(d: Date | undefined, isLive: boolean): string {
  if (!d) return isLive ? "🎥 LIVE" : "📅 Pre-partido";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const liveTag = isLive ? " 🎥 LIVE" : "";
  return `🗓️ ${dd}/${mm} ${hh}:${min}${liveTag}`;
}

function resolveMarketLabel(market: string): string {
  if (MARKET_LABEL[market]) return MARKET_LABEL[market];
  // Handle patterns like "corners O/U 9.5", "goals O/U 2.5", "Totals 2.5/3.5"
  const ouMatch = market.match(/^(\w+)\s+O\/U\s+([\d.]+)$/i);
  if (ouMatch) {
    const baseKey = ouMatch[1].toLowerCase();
    const baseLabel = MARKET_LABEL[baseKey] ?? ouMatch[1];
    return `${baseLabel} +/-${ouMatch[2]}`;
  }
  return market;
}

function formatSurebet(arb: DetectedSurebet): string {
  const sportEmoji = SPORT_EMOJI[arb.sport] ?? "🏅";
  const sportLabel = SPORT_LABEL[arb.sport] ?? arb.sport;
  const datetimeLine = formatDatetime(arb.startTime, arb.isLive);
  const marketLabel = resolveMarketLabel(arb.market);
  const isProps = arb.market === "player_props";

  const header = `💎 <b>Profit: +${arb.profitPct.toFixed(2)}%</b>`;
  const sportLine = `${sportEmoji} ${sportLabel}`;
  const timeLine = datetimeLine;
  const eventLine = `🏆 <b>${arb.eventName}</b>`;
  const marketLine = isProps ? "" : `📊 ${marketLabel}`;

  const legs = arb.legs
    .map(
      (l) =>
        `📕 <b>${l.bookmaker.toUpperCase()}</b> 📍 ${translateSelection(l.selection)} 🎲 @${l.odds.toFixed(2)} 💰 ${l.stake.toFixed(1)}%`,
    )
    .join("\n");

  const footer = `💵 <b>Beneficio garantizado: ${arb.profitPct.toFixed(2)}%</b>`;

  const lines = [header, sportLine, timeLine, eventLine];
  if (marketLine) lines.push(marketLine);
  lines.push("", legs, "", footer);

  return lines.join("\n");
}

function formatMiddle(arb: DetectedMiddle): string {
  const sportEmoji = SPORT_EMOJI[arb.sport] ?? "🏅";
  const sportLabel = SPORT_LABEL[arb.sport] ?? arb.sport;
  const datetimeLine = formatDatetime(arb.startTime, arb.isLive);
  const marketLabel = resolveMarketLabel(arb.market);

  const header = `🎯 <b>MIDDLE +${arb.profitPct.toFixed(2)}%</b>`;
  const sportLine = `${sportEmoji} ${sportLabel}`;
  const timeLine = datetimeLine;
  const eventLine = `🏆 <b>${arb.eventName}</b>`;
  const marketLine = `📊 ${marketLabel} | Ventana: ${arb.windowLow}–${arb.windowHigh}`;

  const legs = arb.legs
    .map(
      (l) =>
        `📕 <b>${l.bookmaker.toUpperCase()}</b> 📍 ${l.selection} 🎲 @${l.odds.toFixed(2)} 💰 ${l.stake.toFixed(1)}%`,
    )
    .join("\n");

  const footer =
    `💵 <b>Si acierta: +${arb.profitPct.toFixed(2)}% | Peor caso: ${arb.worstLoss < 0 ? arb.worstLoss.toFixed(2) : "+" + arb.worstLoss.toFixed(2)}%</b>`;

  return [header, sportLine, timeLine, eventLine, marketLine, "", legs, "", footer].join("\n");
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
  // Support both the new `scanner.enabled` key and the old `surebets_on`/`middlebets_on` format
  return subs.filter((s: (typeof subs)[0]) => {
    const cfg = s.config as any;
    if (cfg?.scanner?.enabled === true || cfg?.scanner?.active === true) return true;
    return cfg?.surebets_on === true || cfg?.middlebets_on === true;
  });
}

/**
 * Check if an arb matches a subscriber's preferences.
 */
// Maps old-format sport keys (soccer, basketball…) to our internal SPORT type
const OLD_SPORT_KEY: Record<string, string> = {
  soccer: "FOOTBALL", football: "FOOTBALL",
  tennis: "TENNIS", basketball: "BASKETBALL",
  baseball_mlb: "BASEBALL", baseball: "BASEBALL",
  icehockey_nhl: "ICEHOCKEY", icehockey: "ICEHOCKEY",
  americanfootball_nfl: "AMERICANFOOTBALL", americanfootball: "AMERICANFOOTBALL",
  rugbyleague: "RUGBYLEAGUE", rugby: "RUGBYLEAGUE",
  volleyball: "VOLLEYBALL", handball: "HANDBALL",
};

function matchesPrefs(arb: DetectedArb, subConfig: any): boolean {
  const sc = subConfig?.scanner ?? {};
  const old = subConfig ?? {};

  // Min profit: check new format first, then old per-type format
  const minProfitNew = sc.min_profit ?? sc.minProfitPct;
  const minProfitOld = arb.type === "SUREBET"
    ? (old.min_profit_surebet ?? old.minProfitSurebet)
    : (old.min_profit_middle ?? old.minProfitMiddle);
  const minProfit = minProfitNew ?? minProfitOld;
  if (minProfit !== undefined && arb.profitPct < Number(minProfit)) return false;

  // Sports filter — new format: string[]; old format: {soccer: true, basketball: false, ...}
  if (sc.sports?.length && !sc.sports.includes(arb.sport)) return false;
  if (old.sports && typeof old.sports === "object" && !Array.isArray(old.sports)) {
    // Object format: { soccer: true, tennis: false } — any key mapping to arb.sport must be true
    const allowed = Object.entries(old.sports as Record<string, boolean>)
      .filter(([, v]) => v === true)
      .map(([k]) => OLD_SPORT_KEY[k] ?? k.toUpperCase());
    if (allowed.length > 0 && !allowed.includes(arb.sport)) return false;
  }

  // Surebet/Middle type filter
  if (arb.type === "SUREBET") {
    if (sc.alertSurebets === false) return false;
    if (sc.alertSurebets === undefined && old.surebets_on === false) return false;
  }
  if (arb.type === "MIDDLE") {
    if (sc.alertMiddles === false) return false;
    if (sc.alertMiddles === undefined && old.middlebets_on === false) return false;
  }

  // Live/prematch filter
  if (arb.isLive) {
    if (sc.alertLive === false) return false;
    if (sc.alertLive === undefined && old.surebets_live_on === false) return false;
  }
  if (!arb.isLive && sc.alertPrematch === false) return false;

  // Bookmakers filter — new format: string[]; old format: {codere: true, bet365: false, ...}
  const arbBooks = arb.legs.map((l: any) => l.bookmaker);
  if (sc.bookmakers?.length) {
    if (!arbBooks.some((b: string) => sc.bookmakers.includes(b))) return false;
  } else if (old.bookmakers && typeof old.bookmakers === "object" && !Array.isArray(old.bookmakers)) {
    const allowed = Object.entries(old.bookmakers as Record<string, boolean>)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    if (allowed.length > 0 && !arbBooks.some((b: string) => allowed.includes(b))) return false;
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

  let notified = 0;
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
      notified++;
    }
  }
  if (notified > 0) {
    console.log(`[notifier] Sent ${notified} notifications for ${newArbs.length} new arbs`);
  }
}
