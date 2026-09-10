/**
 * Sends Telegram alerts for detected arbs.
 *
 * Architecture:
 *  1. notifyArbs() is NON-BLOCKING — pushes to an async queue and returns immediately
 *     so the scanner cycle is never stalled by Telegram API latency or many subscribers.
 *  2. Subscriber configs are cached in memory (60s TTL) to avoid a DB hit per arb cycle.
 *  3. Per-user rate limiter prevents duplicate alerts for the same event within 5 minutes.
 *  4. Gatekeeper validates admin / active subscription / free-trial BEFORE evaluating filters.
 *  5. Bookmaker whitelist requires ALL arb legs to be in the user's allowed list.
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

// ─── Display helpers ──────────────────────────────────────────────────────────

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

const MARKET_UNIT: Record<string, string> = {
  goals: "goles", h1_goals: "goles (1ª parte)", h2_goals: "goles (2ª parte)",
  corners: "córners", yellow_cards: "amarillas", red_cards: "rojas", cards: "tarjetas",
  shots: "disparos a puerta", games: "juegos", sets: "sets",
  aces: "aces", double_faults: "dobles faltas", match_points: "puntos",
  home_runs: "jonrones", runs: "carreras", tries: "ensayos", touchdowns: "touchdowns",
  totals: "puntos",
};

function translateMiddleSelection(selection: string, market: string): string {
  const unit = MARKET_UNIT[market] ?? market;
  const m = selection.match(/^(Over|Under)\s+([\d.]+)$/i);
  if (!m) return selection;
  const dir = m[1].toLowerCase() === "over" ? "Más" : "Menos";
  return `${dir} ${m[2]} ${unit}`;
}

const STAT_LABEL: Record<string, string> = {
  PRA: "puntos + asistencias + rebotes",
  PTS: "puntos", REB: "rebotes", AST: "asistencias", "3PT": "triples",
  shots: "tiros", goals: "goles", passes: "pases", tackles: "entradas",
  corners_taken: "córners", cards: "tarjetas", aces: "aces",
  double_faults: "dobles faltas", first_serve_pct: "% primer saque",
  games: "juegos", hits: "hits", runs_batted_in: "carreras impulsadas",
  strikeouts: "ponches", home_runs: "jonrones", tries: "ensayos",
  conversions: "conversiones", points: "puntos", rebounds: "rebotes",
  assists: "asistencias",
};

function translateSelection(selection: string): string {
  return selection.replace(/\b([A-Za-z0-9_]+)$/, (_, stat) => STAT_LABEL[stat] ?? stat);
}

function resolvePositionalSelection(selection: string, eventName: string): string {
  if (selection === "X") return "Empate";
  if (selection === "1" || selection === "2") {
    // Try " - " first (some scrapers), then " v " (most scrapers use this separator)
    const sep = eventName.includes(" - ") ? " - " : " v ";
    const parts = eventName.split(sep);
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
  const madridOffset = 2; // CEST; adjust to 1 in winter if needed
  const local = new Date(now.getTime() + madridOffset * 3600_000);
  const hh  = String(local.getUTCHours()).padStart(2, "0");
  const min = String(local.getUTCMinutes()).padStart(2, "0");
  const sec = String(local.getUTCSeconds()).padStart(2, "0");
  return `⏱ Enviada a las ${hh}:${min}:${sec}`;
}

function resolveMarketLabel(market: string): string {
  if (MARKET_LABEL[market]) return MARKET_LABEL[market];
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

function oddsAgeTag(scrapedAt?: number): string {
  if (!scrapedAt) return "";
  const sec = Math.round((Date.now() - scrapedAt) / 1000);
  if (sec <= 0) return "";
  const icon = sec <= 30 ? "✅" : sec <= 60 ? "⌛" : "⚠️";
  return ` <i>${icon}${sec}s</i>`;
}

// ─── Message formatters ───────────────────────────────────────────────────────

function formatSurebet(arb: DetectedSurebet, bankrollEur?: number): string {
  const sportEmoji = SPORT_EMOJI[arb.sport] ?? "🏅";
  const sportLabel = SPORT_LABEL[arb.sport] ?? arb.sport;
  const datetimeLine = formatDatetime(arb.startTime, arb.isLive);
  const liveTag = arb.isLive ? " 🎥 LIVE" : "";
  const _tier = arb.league ? classifyCompetition(arb.league, arb.sport) : 2;
  const tierMark = _tier === 1 ? "⭐ " : "";
  const leagueTag = arb.league && !/^tournament_/i.test(arb.league) ? ` (${arb.league})` : "";
  const baseMarket = arb.market.match(/^(\w+)\s+O\/U/i)?.[1]?.toLowerCase() ?? arb.market;
  const legMarketLabel = resolveMarketLabelBySport(arb.market, arb.sport);
  const legs = arb.legs
    .map((l) => {
      const sel = /^(Over|Under)\s+[\d.]+$/i.test(l.selection)
        ? translateMiddleSelection(l.selection, baseMarket)
        : resolvePositionalSelection(translateSelection(l.selection), arb.eventName);
      return `📕 <b>${l.bookmaker.charAt(0).toUpperCase() + l.bookmaker.slice(1)}</b> 📍 ${sel} (${legMarketLabel}) 🎲 @${l.odds.toFixed(2)}${oddsAgeTag(l.scrapedAt)} 💰 ${formatStake(l.stake, bankrollEur)}`;
    })
    .join("\n");

  return [
    `💵 <b>Beneficio: +${arb.profitPct.toFixed(2)}%</b>`,
    `📢 <b>Alerta Surebets!${liveTag}</b>`,
    "",
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
      `📕 <b>${l.bookmaker.charAt(0).toUpperCase() + l.bookmaker.slice(1)}</b> 📍 ${translateMiddleSelection(l.selection, arb.market)} (${legMarketLabel}) 🎲 @${l.odds.toFixed(2)}${oddsAgeTag(l.scrapedAt)} 💰 ${formatStake(l.stake, bankrollEur)}`,
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
        return `📕 ${bookmaker} 📍 ${sel} 🎲 @${leg.odds.toFixed(2)}${oddsAgeTag(leg.scrapedAt)} 💰 ${formatStake(leg.stake, bankrollEur)}`;
      })
      .join("\n");
    lines.push("", profitLine, `${sportEmoji} ${sportLabel}`, datetimeLine, `${tierMark}🏆 <b>${arb.eventName}</b>${leagueTag}`, legLines);
  }

  lines.push("", formatSentAt());
  return lines.join("\n");
}

// ─── 1. Subscriber cache (60s TTL, no DB hit per arb cycle) ──────────────────

interface CachedSub {
  telegramId: string;
  config: any;
  plan: string;
  isAdmin: boolean;
}

const SUB_CACHE_TTL_MS = 60_000;
let _subCache: CachedSub[] = [];
let _subCacheAt = 0;

function invalidateSubCache(): void { _subCacheAt = 0; }

async function getCachedSubscribers(): Promise<CachedSub[]> {
  if (Date.now() - _subCacheAt < SUB_CACHE_TTL_MS) return _subCache;
  const now = new Date();
  const rows = await prisma.botSubscription.findMany({
    where: {
      OR: [
        { expiresAt: null },                         // admin / permanent
        { expiresAt: { gt: now } },                  // active subscription
      ],
    },
    select: { telegramId: true, config: true, plan: true, expiresAt: true },
  });

  type SubRow = typeof rows[number];
  _subCache = rows
    .filter((s: SubRow) => {
      const cfg = s.config as any;
      // Gatekeeper: scanner must be enabled in config
      if (cfg?.scanner?.enabled === true || cfg?.scanner?.active === true) return true;
      return cfg?.surebets_on === true || cfg?.middlebets_on === true;
    })
    .map((s: SubRow) => ({
      telegramId: s.telegramId,
      config: s.config,
      plan: s.plan,
      isAdmin: s.expiresAt === null,   // null expiry = permanent admin
    }));

  _subCacheAt = Date.now();
  return _subCache;
}

// ─── 2. Per-user rate limiter (prevents alert spam) ──────────────────────────
// Key: `{telegramId}::{eventName}::{type}::{market}` → last sent ms
// Same arb to same user: max once per 5 minutes.

const RATE_LIMIT_MS = 5 * 60_000;
const _rateLimitMap = new Map<string, number>();

// Cleanup stale rate-limit entries every 10 min to prevent memory growth
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_MS * 2;
  for (const [k, ts] of _rateLimitMap) {
    if (ts < cutoff) _rateLimitMap.delete(k);
  }
}, 10 * 60_000);

function isRateLimited(telegramId: string, arb: DetectedArb): boolean {
  const key = `${telegramId}::${arb.eventName}::${arb.type}::${arb.market}`;
  const last = _rateLimitMap.get(key) ?? 0;
  if (Date.now() - last < RATE_LIMIT_MS) return true;
  _rateLimitMap.set(key, Date.now());
  return false;
}

// ─── 3. Per-user filter engine ────────────────────────────────────────────────

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
  // Normalise: sc = new-format scanner block; old = legacy flat config
  const sc = (subConfig?.scanner?.active === false || subConfig?.scanner?.enabled === false)
    ? {}
    : (subConfig?.scanner ?? {});
  const old = subConfig ?? {};

  // ── Type switches ─────────────────────────────────────────────────────────
  if (arb.type === "SUREBET") {
    const on = sc.surebets_enabled ?? sc.alertSurebets;
    if (on === false) return false;
    if (on === undefined && old.surebets_on === false) return false;
  }
  if (arb.type === "MIDDLE") {
    const on = sc.middlebets_enabled ?? sc.alertMiddles;
    if (on === false) return false;
    if (on === undefined && old.middlebets_on === false) return false;
  }

  // ── Live / prematch switches ──────────────────────────────────────────────
  if (arb.isLive) {
    const on = sc.live_enabled ?? sc.alertLive;
    if (on === false) return false;
    if (on === undefined && old.surebets_live_on === false) return false;
  }
  if (!arb.isLive) {
    const on = sc.prematch_enabled ?? sc.alertPrematch;
    if (on === false) return false;
  }

  // Skip prematch events whose start time has already passed
  if (!arb.isLive && arb.startTime && arb.startTime.getTime() < Date.now()) return false;

  // ── Min profit thresholds ─────────────────────────────────────────────────
  if (arb.type === "SUREBET") {
    const minProfit =
      sc.min_profit_surebets ?? sc.min_profit ?? sc.minProfitPct ??
      old.min_profit_surebet ?? old.minProfitSurebet;
    if (minProfit !== undefined && arb.profitPct < Number(minProfit)) return false;
  }
  if (arb.type === "MIDDLE") {
    const minProfit =
      sc.min_profit_middlebet ?? sc.min_profit ?? sc.minProfitPct ??
      old.min_profit_middle ?? old.minProfitMiddle;
    if (minProfit !== undefined && arb.profitPct < Number(minProfit)) return false;

    // Min middle probability threshold
    const minProb =
      sc.min_prob_middle ?? sc.minProbMiddle ?? old.min_prob_middle;
    if (minProb !== undefined) {
      const prob = (arb as DetectedMiddle).middleProbability * 100;
      if (prob < Number(minProb)) return false;
    }
  }

  // ── Pre-match days-ahead filter ───────────────────────────────────────────
  // Accepts: sc.max_prematch_days | sc.prematch_days_filter | sc.max_days | old.max_days
  if (!arb.isLive && arb.startTime) {
    const maxDays =
      sc.max_prematch_days ?? sc.prematch_days_filter ?? sc.max_days ?? sc.maxDaysAhead ??
      old.max_days;
    if (maxDays !== undefined) {
      const msLimit = Number(maxDays) * 24 * 3600_000;
      if (arb.startTime.getTime() - Date.now() > msLimit) return false;
    }
  }

  // ── Sports whitelist ──────────────────────────────────────────────────────
  const allowedSports: string[] | undefined =
    Array.isArray(sc.allowed_sports) ? sc.allowed_sports :
    Array.isArray(sc.sports) ? sc.sports : undefined;

  if (allowedSports?.length && !allowedSports.includes(arb.sport)) return false;

  // Legacy object format: { soccer: true, tennis: false }
  if (old.sports && typeof old.sports === "object" && !Array.isArray(old.sports)) {
    const allowed = Object.entries(old.sports as Record<string, boolean>)
      .filter(([, v]) => v === true)
      .map(([k]) => OLD_SPORT_KEY[k] ?? k.toUpperCase());
    if (allowed.length > 0 && !allowed.includes(arb.sport)) return false;
  }

  // ── Bookmaker whitelist (EXCLUSIVE: ALL legs must be in the allowed list) ─
  const allowedBooks: string[] | undefined =
    Array.isArray(sc.allowed_bookmakers) ? sc.allowed_bookmakers :
    Array.isArray(sc.bookmakers) ? sc.bookmakers : undefined;

  if (allowedBooks?.length) {
    const arbBooks = arb.legs.map((l) => l.bookmaker);
    if (!arbBooks.every((b) => allowedBooks.includes(b))) return false;
  } else if (old.bookmakers && typeof old.bookmakers === "object" && !Array.isArray(old.bookmakers)) {
    const allowed = Object.entries(old.bookmakers as Record<string, boolean>)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    if (allowed.length > 0) {
      const arbBooks = arb.legs.map((l) => l.bookmaker);
      if (!arbBooks.every((b) => allowed.includes(b))) return false;
    }
  }

  // ── Draw-risk guard (football/icehockey h2h surebets don't cover draw) ───
  if (arb.type === "SUREBET" && arb.market === "h2h" && THREE_WAY_SPORTS.has(arb.sport)) {
    const blockDraw = sc.blockDrawRisk ?? old.block_draw_risk_surebets;
    if (blockDraw !== false) return false;
  }

  return true;
}

// ─── 4. Async notification queue (scanner never blocks on Telegram I/O) ──────

type NotifyJob = Array<{ dbId: string; arb: DetectedArb; detectedAt: number }>;

const _queue: NotifyJob[] = [];
let _processing = false;

async function _processQueue(): Promise<void> {
  if (_processing) return;
  _processing = true;
  try {
    while (_queue.length > 0) {
      const batch = _queue.shift()!;
      await _dispatchBatch(batch);
    }
  } finally {
    _processing = false;
  }
}

async function _dispatchBatch(
  newArbs: Array<{ dbId: string; arb: DetectedArb; detectedAt: number }>,
): Promise<void> {
  if (!newArbs.length) return;

  // High-profit arbs first (smart queue)
  const prioritized = [...newArbs].sort((a, b) => b.arb.profitPct - a.arb.profitPct);

  const subscribers = await getCachedSubscribers();
  if (!subscribers.length) return;

  let notified = 0;

  for (const sub of subscribers) {
    // ── Per-user filter ──────────────────────────────────────────────────────
    const matching = prioritized.filter(({ arb }) => matchesPrefs(arb, sub.config));
    if (!matching.length) continue;

    // ── Rate limiting: skip events already alerted within 5 min ─────────────
    const deduped = matching.filter(({ arb }) => !isRateLimited(sub.telegramId, arb));
    if (!deduped.length) continue;

    const bankrollEur: number | undefined = (sub.config as any)?.stake > 0
      ? Number((sub.config as any).stake) : undefined;
    const hasTracker = sub.plan === "PRO_TRACKER" || sub.plan === "ENTERPRISE";

    // Group by event+type so same match = one message
    const groups = new Map<string, Array<{ dbId: string; arb: DetectedArb }>>();
    for (const item of deduped) {
      const key = `${item.arb.sport}::${item.arb.eventName}::${item.arb.type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }

    for (const group of groups.values()) {
      // Dedup via ArbNotification unique constraint (arbId + telegramId)
      const toSend: Array<{ dbId: string; arb: DetectedArb }> = [];
      for (const item of group) {
        try {
          await prisma.arbNotification.create({
            data: { arbId: item.dbId, telegramId: sub.telegramId },
          });
          toSend.push(item);
        } catch (err: any) {
          if (err.code !== "P2002") throw err; // P2002 = already sent
        }
      }
      if (!toSend.length) continue;

      if (toSend.length === 1) {
        const { dbId, arb } = toSend[0];
        const replyMarkup = {
          inline_keyboard: [[
            ...(hasTracker ? [{ text: "✅ Hecha", callback_data: `SCAN_AH_${sub.telegramId}_${dbId}` }] : []),
            { text: "❌ No hecha", callback_data: `SCAN_ANH_${sub.telegramId}_${dbId}` },
          ]],
        };
        await sendMessage(sub.telegramId, formatArb(arb, bankrollEur), replyMarkup);
      } else {
        await sendMessage(sub.telegramId, formatGroupedArbs(toSend.map((i) => i.arb), bankrollEur));
      }
      notified += toSend.length;
    }
  }

  if (notified > 0) {
    console.log(`[notifier] Sent notifications for ${notified} arbs`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Non-blocking entry point — called after each arb detection cycle.
 * Pushes work to the async queue and returns immediately so the scanner
 * can start the next poll cycle without waiting for Telegram I/O.
 */
export async function notifyArbs(
  newArbs: Array<{ dbId: string; arb: DetectedArb; detectedAt: number }>,
): Promise<void> {
  if (!newArbs.length) return;
  _queue.push(newArbs);
  // Fire-and-forget: do NOT await — scanner must not block on notification
  _processQueue().catch((err) => console.error("[notifier] Queue error:", err));
}

/** Force-refresh the subscriber cache (call after admin changes a user's config). */
export function refreshSubscriberCache(): void {
  invalidateSubCache();
}
