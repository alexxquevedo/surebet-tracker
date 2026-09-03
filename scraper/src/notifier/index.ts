/**
 * Sends Telegram alerts for detected arbs.
 * Reads subscriber list from BotSubscription table and filters by their config.
 */

import axios from "axios";
import { config } from "../config";
import prisma from "../db";
import type { DetectedArb, DetectedSurebet, DetectedMiddle } from "../types";
import { classifyCompetition } from "../matcher/competitions";

const TG_API = `https://api.telegram.org/bot${config.telegram.token}`;

async function sendMessage(
  chatId: string,
  text: string,
  replyMarkup?: object,
): Promise<number | undefined> {
  try {
    const res = await axios.post(`${TG_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: JSON.stringify(replyMarkup) } : {}),
    });
    return res.data?.result?.message_id;
  } catch (err: any) {
    console.warn(`[notifier] Failed to send to ${chatId}:`, err?.message);
    return undefined;
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
  h2h: "1X2",
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

// Sports where h2h draw is possible — filter out 2-leg surebets (draw not covered)
const THREE_WAY_SPORTS = new Set(["FOOTBALL", "HOCKEY", "BASKETBALL"]);

function resolveMarketLabelBySport(market: string, sport: string): string {
  if (market === "h2h") {
    if (THREE_WAY_SPORTS.has(sport)) return "1X2";
    if (sport === "TENNIS") return "Gana el partido";
    return "Ganador";
  }
  if (market === "sets") return "Gana el set";
  if (market === "games") return "Gana el juego";
  return resolveMarketLabel(market);
}

// Market → Spanish unit for O/U middle legs ("Over 1.5 goles", "Más 3.5 córners")
const MARKET_UNIT: Record<string, string> = {
  goals: "goles", h1_goals: "goles (1ª parte)", h2_goals: "goles (2ª parte)",
  corners: "córners", yellow_cards: "amarillas", red_cards: "rojas", cards: "tarjetas",
  shots: "disparos a puerta", games: "juegos", sets: "sets",
  aces: "aces", double_faults: "dobles faltas", match_points: "puntos",
  home_runs: "jonrones", runs: "carreras", tries: "ensayos", touchdowns: "touchdowns",
  totals: "puntos",
};

/** Translates "Over 1.5" / "Under 3.5" to "Más 1.5 goles" / "Menos 3.5 goles" for a given market */
function translateMiddleSelection(selection: string, market: string): string {
  const unit = MARKET_UNIT[market] ?? market;
  const m = selection.match(/^(Over|Under)\s+([\d.]+)$/i);
  if (!m) return selection;
  const dir = m[1].toLowerCase() === "over" ? "Más" : "Menos";
  return `${dir} ${m[2]} ${unit}`;
}

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

function resolvePositionalSelection(selection: string, eventName: string): string {
  if (selection === "X") return "Empate";
  if (selection === "1" || selection === "2") {
    const parts = eventName.split(" - ");
    if (parts.length >= 2) {
      return selection === "1" ? parts[0].trim() : parts[parts.length - 1].trim();
    }
  }
  return selection;
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

function formatSentAt(): string {
  const now = new Date();
  // Use Spain local time (UTC+2 in summer, UTC+1 in winter)
  const madridOffset = 2; // CEST; adjust to 1 in winter if needed
  const local = new Date(now.getTime() + madridOffset * 3600_000);
  const hh  = String(local.getUTCHours()).padStart(2, "0");
  const min = String(local.getUTCMinutes()).padStart(2, "0");
  const sec = String(local.getUTCSeconds()).padStart(2, "0");
  return `⏱ Enviada a las ${hh}:${min}:${sec}`;
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

function formatStake(stakePercent: number, bankrollEur?: number): string {
  const pct = `${stakePercent.toFixed(2)}%`;
  if (bankrollEur && bankrollEur > 0) {
    const eur = ((stakePercent / 100) * bankrollEur).toFixed(2);
    return `${pct} (€${eur})`;
  }
  return pct;
}

function formatSurebet(arb: DetectedSurebet, bankrollEur?: number): string {
  const sportEmoji = SPORT_EMOJI[arb.sport] ?? "🏅";
  const sportLabel = SPORT_LABEL[arb.sport] ?? arb.sport;
  const datetimeLine = formatDatetime(arb.startTime, arb.isLive);
  const liveTag = arb.isLive ? " 🎥 LIVE" : "";

  const _tier = arb.league ? classifyCompetition(arb.league, arb.sport) : 2;
  const tierMark = _tier === 1 ? "⭐ " : "";
  const leagueTag = arb.league && !/^tournament_/i.test(arb.league) ? ` (${arb.league})` : "";
  // For O/U surebets (market = "goals O/U 4.5"), extract the base market key for translation
  const baseMarket = arb.market.match(/^(\w+)\s+O\/U/i)?.[1]?.toLowerCase() ?? arb.market;
  const legMarketLabel = resolveMarketLabelBySport(arb.market, arb.sport);
  const legs = arb.legs
    .map((l) => {
      const sel = /^(Over|Under)\s+[\d.]+$/i.test(l.selection)
        ? translateMiddleSelection(l.selection, baseMarket)
        : resolvePositionalSelection(translateSelection(l.selection), arb.eventName);
      return `📕 <b>${l.bookmaker.charAt(0).toUpperCase() + l.bookmaker.slice(1)}</b> 📍 ${sel} (${legMarketLabel}) 🎲 @${l.odds.toFixed(2)} 💰 ${formatStake(l.stake, bankrollEur)}`;
    })
    .join("\n");

  return [
    `💵 <b>Beneficio: +${arb.profitPct.toFixed(2)}%</b>`,
    `📢 <b>Alerta Surebets!${liveTag}</b>`,
    "",
    `💎 Profit: +${arb.profitPct.toFixed(2)}%`,
    `${sportEmoji} ${sportLabel}`,
    datetimeLine,
    `${tierMark}🏆 <b>${arb.eventName}</b>${leagueTag}`,
    legs,
    ...(arb.isLive ? ["", "⚠️ <i>Verifica cuotas antes de apostar — mercados live cambian rápido</i>"] : []),
    formatSentAt(),
  ].join("\n");
}

function formatMiddle(arb: DetectedMiddle, bankrollEur?: number): string {
  const sportEmoji = SPORT_EMOJI[arb.sport] ?? "🏅";
  const sportLabel = SPORT_LABEL[arb.sport] ?? arb.sport;
  const datetimeLine = formatDatetime(arb.startTime, arb.isLive);
  const liveTag = arb.isLive ? " 🎥 LIVE" : "";
  const probPct = (arb.middleProbability * 100).toFixed(2);

  const _tier = arb.league ? classifyCompetition(arb.league, arb.sport) : 2;
  const tierMark = _tier === 1 ? "⭐ " : "";
  const leagueTag = arb.league && !/^tournament_/i.test(arb.league) ? ` (${arb.league})` : "";
  const legMarketLabel = resolveMarketLabelBySport(arb.market, arb.sport);
  const legs = arb.legs
    .map((l) =>
      `📕 <b>${l.bookmaker.charAt(0).toUpperCase() + l.bookmaker.slice(1)}</b> 📍 ${translateMiddleSelection(l.selection, arb.market)} (${legMarketLabel}) 🎲 @${l.odds.toFixed(2)} 💰 ${formatStake(l.stake, bankrollEur)}`,
    )
    .join("\n");

  return [
    `👑 <b>Valor Esperado: +${arb.profitPct.toFixed(2)}% - +${arb.maxProfitPct.toFixed(2)}%</b>`,
    `📢 <b>Alerta Middlebets!${liveTag}</b>`,
    "",
    `💎 Valor esperado: +${arb.profitPct.toFixed(2)}% (Sin riesgo)`,
    `📉 Mín. ${arb.profitPct.toFixed(2)}% | 📈 Máx. ${arb.maxProfitPct.toFixed(2)}%`,
    `🍀 Probabilidad middle: ${probPct}%`,
    "",
    `${sportEmoji} ${sportLabel}`,
    datetimeLine,
    `${tierMark}🏆 <b>${arb.eventName}</b>${leagueTag}`,
    legs,
    ...(arb.isLive ? ["", "⚠️ <i>Verifica cuotas antes de apostar — mercados live cambian rápido</i>"] : []),
    formatSentAt(),
  ].join("\n");
}

function formatArb(arb: DetectedArb, bankrollEur?: number): string {
  return arb.type === "SUREBET"
    ? formatSurebet(arb as DetectedSurebet, bankrollEur)
    : formatMiddle(arb as DetectedMiddle, bankrollEur);
}

function formatGroupedArbs(arbs: DetectedArb[], bankrollEur?: number): string {
  // Sort highest profit first
  const sorted = [...arbs].sort((a, b) => b.profitPct - a.profitPct);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const isLive = sorted.some((a) => a.isLive);
  const liveTag = isLive ? " 🎥 LIVE" : "";
  const typeLabel = first.type === "SUREBET" ? "Surebets" : "Middlebets";

  const headerProfit = first.type === "SUREBET"
    ? `💵 <b>Beneficio: ${first.profitPct.toFixed(2)}% - ${last.profitPct.toFixed(2)}%</b>`
    : `👑 <b>Valor Esperado: ${first.profitPct.toFixed(2)}% - ${last.profitPct.toFixed(2)}%</b>`;

  const lines: string[] = [headerProfit, `📢 <b>Alerta ${typeLabel}!${liveTag}</b>`];

  for (const arb of sorted) {
    const sportEmoji = SPORT_EMOJI[arb.sport] ?? "🏅";
    const sportLabel = SPORT_LABEL[arb.sport] ?? arb.sport;
    const datetimeLine = formatDatetime((arb as any).startTime, arb.isLive);
    const _tier = arb.league ? classifyCompetition(arb.league, arb.sport) : 2;
  const tierMark = _tier === 1 ? "⭐ " : "";
  const leagueTag = arb.league && !/^tournament_/i.test(arb.league) ? ` (${arb.league})` : "";

    const profitLine = arb.type === "SUREBET"
      ? `💎 Profit: +${arb.profitPct.toFixed(2)}%`
      : `💎 Valor esperado: +${arb.profitPct.toFixed(2)}% ~ +${(arb as DetectedMiddle).maxProfitPct.toFixed(2)}%`;

    const baseMarket = arb.market.match(/^(\w+)\s+O\/U/i)?.[1]?.toLowerCase() ?? arb.market;
    const legLines = arb.legs
      .map((leg) => {
        const bookmaker = leg.bookmaker.charAt(0).toUpperCase() + leg.bookmaker.slice(1);
        const sel = /^(Over|Under)\s+[\d.]+$/i.test(leg.selection)
          ? translateMiddleSelection(leg.selection, baseMarket)
          : resolvePositionalSelection(translateSelection(leg.selection), arb.eventName);
        return `📕 ${bookmaker} 📍 ${sel} 🎲 @${leg.odds.toFixed(2)} 💰 ${formatStake(leg.stake, bankrollEur)}`;
      })
      .join("\n");

    lines.push("", profitLine, `${sportEmoji} ${sportLabel}`, datetimeLine, `${tierMark}🏆 <b>${arb.eventName}</b>${leagueTag}`, legLines);
  }

  lines.push("", formatSentAt());
  return lines.join("\n");
}

/**
 * Get all active bot subscribers that have the scanner feature enabled.
 * Each subscriber's config JSON may contain a "scanner" key with their preferences.
 */
async function getActiveSubscribers(): Promise<
  Array<{ telegramId: string; config: any; plan: string }>
> {
  const now = new Date();
  const subs = await prisma.botSubscription.findMany({
    where: {
      OR: [
        { expiresAt: null },          // permanent / admin
        { expiresAt: { gt: now } },   // active subscription
      ],
    },
    select: { telegramId: true, config: true, plan: true },
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
  icehockey_nhl: "HOCKEY", icehockey: "HOCKEY",
  americanfootball_nfl: "AMERICANFOOTBALL", americanfootball: "AMERICANFOOTBALL",
  rugbyleague: "RUGBYLEAGUE", rugby: "RUGBYLEAGUE",
  volleyball: "VOLLEYBALL", handball: "HANDBALL",
};

function matchesPrefs(arb: DetectedArb, subConfig: any): boolean {
  const sc = (subConfig?.scanner?.active === false || subConfig?.scanner?.enabled === false)
    ? {}
    : (subConfig?.scanner ?? {});
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

  // Skip pre-match alerts for games that have already started
  if (!arb.isLive && arb.startTime && arb.startTime.getTime() < Date.now()) return false;

  // Pre-match days-ahead filter: config field "max_days" (old format) or sc.max_days / sc.maxDaysAhead
  if (!arb.isLive && arb.startTime) {
    const maxDays = sc.max_days ?? sc.maxDaysAhead ?? old.max_days;
    if (maxDays !== undefined) {
      const msLimit = Number(maxDays) * 24 * 3600 * 1000;
      if (arb.startTime.getTime() - Date.now() > msLimit) return false;
    }
  }

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

  // Draw-risk: football/icehockey h2h surebets do not cover draw
  if (arb.type === "SUREBET" && arb.market === "h2h" && THREE_WAY_SPORTS.has(arb.sport)) {
    const blockDraw = sc.blockDrawRisk ?? old.block_draw_risk_surebets;
    if (blockDraw !== false) return false;
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
  for (const sub of subscribers) {
    const bankrollEur: number | undefined = (sub.config as any)?.stake > 0
      ? Number((sub.config as any).stake) : undefined;
    const hasTracker = sub.plan === "PRO_TRACKER" || sub.plan === "ENTERPRISE";

    // Per-user filter: draw-risk for football/icehockey is inside matchesPrefs
    const matching = newArbs.filter(({ arb }) => matchesPrefs(arb, sub.config));
    if (!matching.length) continue;

    // Group by event+type so same match = one message
    const groups = new Map<string, Array<{ dbId: string; arb: DetectedArb }>>();
    for (const item of matching) {
      const key = `${item.arb.sport}::${item.arb.eventName}::${item.arb.type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }

    for (const group of groups.values()) {
      // Record each arb — unique constraint prevents duplicates; skip already-notified ones
      const toSend: Array<{ dbId: string; arb: DetectedArb }> = [];
      for (const item of group) {
        try {
          await prisma.arbNotification.create({
            data: { arbId: item.dbId, telegramId: sub.telegramId },
          });
          toSend.push(item);
        } catch (err: any) {
          if (err.code !== "P2002") throw err;
        }
      }
      if (!toSend.length) continue;

      if (toSend.length === 1) {
        // Single arb: send individual message with ✅/❌ buttons
        const { dbId, arb } = toSend[0];
        const replyMarkup = {
          inline_keyboard: [[
            ...(hasTracker ? [{ text: "✅ Hecha", callback_data: `SCAN_AH_${sub.telegramId}_${dbId}` }] : []),
            { text: "❌ No hecha", callback_data: `SCAN_ANH_${sub.telegramId}_${dbId}` },
          ]],
        };
        await sendMessage(sub.telegramId, formatArb(arb, bankrollEur), replyMarkup);
      } else {
        // Multiple arbs same event: one grouped message (no per-arb buttons)
        await sendMessage(sub.telegramId, formatGroupedArbs(toSend.map((i) => i.arb), bankrollEur));
      }
      notified += toSend.length;
    }
  }
  if (notified > 0) {
    console.log(`[notifier] Sent notifications for ${notified} arbs`);
  }
}
