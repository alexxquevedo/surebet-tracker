/**
 * Health checker — tracks consecutive zero-event cycles per bookmaker/mode
 * and fires Telegram CRITICAL alerts after ALERT_AFTER consecutive failures.
 *
 * Usage:
 *   healthUpdate("bwin", false, 0)  → increments failure counter
 *   healthUpdate("bwin", false, 42) → resets counter, logs recovery
 *   healthReport()                  → snapshot for logging
 */

// Ciclos consecutivos a 0 antes de alertar. Solo alerta si el scraper
// tenía datos antes (lastSeen !== null) — los bloqueados por proxy nunca alertan.
const ALERT_AFTER = 5;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const ADMIN_IDS: number[] = [1207554638, 2051653218];

interface HealthRecord {
  consecutive: number;
  lastSeen: Date | null;
  alertSent: boolean;
}

const state = new Map<string, HealthRecord>();

function k(bookmaker: string, isLive: boolean): string {
  return `${bookmaker}:${isLive ? "live" : "pre"}`;
}

function rec(key: string): HealthRecord {
  if (!state.has(key)) state.set(key, { consecutive: 0, lastSeen: null, alertSent: false });
  return state.get(key)!;
}

export function healthUpdate(bookmaker: string, isLive: boolean, count: number): void {
  const key = k(bookmaker, isLive);
  const r = rec(key);

  if (count > 0) {
    if (r.consecutive >= ALERT_AFTER) {
      console.log(`[health] ${bookmaker} ${isLive ? "LIVE" : "PRE"} recovered — ${count} events (was dead ${r.consecutive} cycles)`);
    }
    r.consecutive = 0;
    r.lastSeen = new Date();
    r.alertSent = false;
  } else {
    r.consecutive++;
    // Solo alerta si el scraper tenía datos previos (lastSeen !== null).
    // Los scrapers bloqueados por proxy NUNCA han devuelto eventos → no alertar.
    if (r.consecutive >= ALERT_AFTER && !r.alertSent && r.lastSeen !== null) {
      r.alertSent = true;
      void sendCritical(bookmaker, isLive, r.consecutive);
    }
  }
  state.set(key, r);
}

export function healthReport(): Record<string, { status: string; zeros: number; lastSeen: string | null }> {
  const out: Record<string, { status: string; zeros: number; lastSeen: string | null }> = {};
  for (const [key, r] of state) {
    out[key] = {
      status: r.consecutive >= ALERT_AFTER ? "DEAD" : r.lastSeen ? "OK" : "INIT",
      zeros: r.consecutive,
      lastSeen: r.lastSeen?.toISOString() ?? null,
    };
  }
  return out;
}

async function sendCritical(bookmaker: string, isLive: boolean, zeros: number): Promise<void> {
  const msg =
    `🚨 <b>CRITICAL — FidesBot Scanner</b>\n` +
    `Casa: <b>${bookmaker.toUpperCase()}</b>\n` +
    `Modo: ${isLive ? "⚡ LIVE" : "📅 PREMATCH"}\n` +
    `Ciclos sin eventos: <b>${zeros}</b>\n` +
    `Posible causa: URL rota, geo-bloqueo o cambio de API.`;

  console.error(`[health] CRITICAL: ${bookmaker} ${isLive ? "live" : "prematch"} → ${zeros} consecutive zero cycles`);

  if (!TELEGRAM_TOKEN) return;
  for (const chatId of ADMIN_IDS) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }),
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) console.warn(`[health] TG alert failed: ${res.status}`);
    } catch (err) {
      console.warn("[health] TG send error:", err);
    }
  }
}
