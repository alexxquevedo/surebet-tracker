/**
 * Winamax France — Playwright XHR interception scraper.
 *
 * Winamax uses an SPA that handles routing client-side. Server-side navigation
 * to sport URLs (e.g. /paris-sportifs/football) triggers a server redirect
 * back to /paris-sportifs/. Solution: load the SPA once, then click sport
 * navigation links in the DOM to trigger client-side routing + XHR data loading.
 *
 * Winamax blocks page.request.get() (WAF → 403/404).
 */

import { BaseScraper } from "./base";
import { browserManager, dismissCookies, captureJsonRequests, logPageState } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine, PlayerPropLine } from "../types";
import type { Page } from "playwright";

const BASE_FR = "https://www.winamax.fr";

// Confirmed from DOM discovery (2026-07-29): 1=Football, 2=Basketball, 5=Tennis
// Actual DOM hrefs: /paris-sportifs/sports/1 (Football), /paris-sportifs/sports/5 (Tennis)
// Volleyball ID 11 unconfirmed — will be auto-discovered via WS state sport dump
const SPORT_IDS: Partial<Record<Sport, number>> = {
  FOOTBALL: 1,
  TENNIS: 5,
  BASKETBALL: 2,
  VOLLEYBALL: 11,
};

const SPORT_HREF_PATTERNS: Partial<Record<Sport, string[]>> = {
  FOOTBALL:   ["/paris-sportifs/sports/1", "/paris-sportifs/sports/1/"],
  TENNIS:     ["/paris-sportifs/sports/5", "/paris-sportifs/sports/5/"],
  BASKETBALL: ["/paris-sportifs/sports/2", "/paris-sportifs/sports/2/"],
  VOLLEYBALL: ["/paris-sportifs/sports/11", "/paris-sportifs/sports/11/"],
};

// Fallback text-based click labels (French site)
const SPORT_LINK_TEXTS: Partial<Record<Sport, string[]>> = {
  FOOTBALL:   ["football", "foot"],
  TENNIS:     ["tennis"],
  BASKETBALL: ["basket", "basketball"],
  VOLLEYBALL: ["volleyball", "volley"],
};

function parseWinamaxData(raw: any, sport: Sport, isLive: boolean, srcUrl: string): ScrapedEvent[] {
  const events: ScrapedEvent[] = [];
  const sportId = SPORT_IDS[sport];

  let competitions: any[] = [];

  if (raw?.sports) {
    const sportData = sportId != null ? (raw.sports[sportId] ?? raw.sports[String(sportId)]) : undefined;
    if (sportData?.competitions) {
      competitions = sportData.competitions;
    } else if (Array.isArray(raw.sports)) {
      const s = raw.sports.find((x: any) => x.id === sportId || x.sportId === sportId);
      competitions = s?.competitions ?? [];
    }
  } else if (Array.isArray(raw?.competitions)) {
    competitions = raw.competitions;
  } else if (Array.isArray(raw?.matches)) {
    return parseMatches(raw.matches, sport, isLive, "");
  }

  for (const comp of competitions) {
    const league: string = comp.label ?? comp.name ?? comp.fullName ?? "";
    const matches: any[] = comp.matches ?? comp.events ?? [];
    events.push(...parseMatches(matches, sport, isLive, league));
  }
  return events;
}

function parseMatches(matches: any[], sport: Sport, isLive: boolean, league: string): ScrapedEvent[] {
  const events: ScrapedEvent[] = [];
  for (const match of matches) {
    if (typeof match !== "object" || !match) continue;

    const teams: any[] = match.teams ?? match.participants ?? [];
    let home = "", away = "";
    if (teams.length >= 2) {
      home = teams[0]?.name ?? teams[0]?.label ?? "";
      away = teams[1]?.name ?? teams[1]?.label ?? "";
    }
    const eventName: string =
      match.title ?? match.label ?? match.name ??
      (home && away ? `${home} - ${away}` : "");
    if (!eventName) continue;

    const startTime = match.matchStart ?? match.date ?? match.startDate;
    const eventKey = buildEventKey(
      sport, eventName,
      startTime ? new Date(typeof startTime === "number" ? startTime * 1000 : startTime) : undefined,
    );

    const bets: any[] = match.bets ?? match.markets ?? match.betOffers ?? match.offers ?? [];

    for (const bet of bets) {
      const title: string = (bet.betTitle ?? bet.label ?? bet.name ?? "").toLowerCase();
      const choices: any[] = bet.betChoices ?? bet.outcomes ?? bet.selections ?? [];

      const isH2H =
        title.includes("1x2") || title.includes("resultado") ||
        title.includes("match") || title.includes("ganador") ||
        title.includes("vainqueur") || title.includes("winner") ||
        title.includes("résultat");

      if (isH2H) {
        const h2h: H2HOutcome[] = choices.map((c: any) => {
          const odds = typeof c.odds === "number" ? c.odds : parseFloat(c.odds ?? c.price ?? "0");
          const name: string = c.label ?? c.name ?? c.type ?? "";
          return odds >= 1.01 && name ? { name, odds } : null;
        }).filter(Boolean) as H2HOutcome[];
        if (h2h.length >= 2) {
          events.push({ bookmaker: "winamax", sport, eventKey, eventName, league, isLive, market: "h2h", outcomes: h2h });
        }
      } else if (title.includes("total") || title.includes("over") || title.includes("plus/moins") || title.includes("más/menos")) {
        const byLine = new Map<number, TotalsLine>();
        for (const c of choices) {
          const lbl: string = (c.label ?? c.name ?? "").toLowerCase();
          const odds = typeof c.odds === "number" ? c.odds : parseFloat(c.odds ?? c.price ?? "0");
          const lm = lbl.match(/(\d+[.,]\d+)/);
          if (!lm || odds < 1.01) continue;
          const line = parseFloat(lm[1].replace(",", "."));
          const entry = byLine.get(line) ?? { line, over: 0, under: 0 };
          if (lbl.includes("más") || lbl.includes("over") || lbl.includes("+") || lbl.includes("plus")) entry.over = odds;
          else entry.under = odds;
          byLine.set(line, entry);
        }
        const totals = [...byLine.values()].filter(t => t.over > 0 && t.under > 0);
        if (totals.length > 0) {
          events.push({ bookmaker: "winamax", sport, eventKey, eventName, league, isLive, market: "totals", outcomes: totals });
        }
      }
    }
  }
  return events;
}

/** Merge all Socket.IO "m" messages into a single state object */
function mergeWsMessage(state: Record<string, any>, msg: Record<string, any>): void {
  for (const [k, v] of Object.entries(msg)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof state[k] === "object" && !Array.isArray(state[k])) {
      mergeWsMessage(state[k], v as Record<string, any>);
    } else {
      state[k] = v;
    }
  }
}

// ─── Secondary market parsing (corners, cards, handicap, O/U goals, player props) ────

// Maps French bet titles to canonical market keys
const MARKET_CAT_MAP: Array<[RegExp, string]> = [
  // ── Handicap (must come before goals to avoid "buts handicap" matching goals) ──
  [/handicap|hándicap/i,                                                            "handicap"],
  // ── Corners ──
  [/corners?|coups?\s+de\s+coin/i,                                                 "corners"],
  // ── Cards ──
  [/cartons?\s+jaunes?/i,                                                           "yellow_cards"],
  [/cartons?\s+rouges?/i,                                                           "red_cards"],
  [/cartons?\s+totaux|total\s+cartons?/i,                                           "cards"],
  // ── Half goals ──
  [/(?:1[eè]re?|premi[eè]re?)\s*mi[\s-]?temps|mi[\s-]?temps\s+(?:1|premi[eè]re?)/i, "h1_goals"],
  [/(?:2[eè]me?|deuxi[eè]me?)\s*mi[\s-]?temps/i,                                  "h2_goals"],
  // ── Goals (full match) ──
  [/nombre\s+de\s+buts?|total\s+buts?|\bbuts?\b/i,                                 "goals"],
  // ── Tennis / Padel ──
  [/\baces?\b/i,                                                                    "aces"],
  [/double[s]?\s*faute[s]?/i,                                                      "double_faults"],
  [/nombre\s+de\s+jeux|total\s+jeux|\bjeux\b/i,                                    "games"],
  [/nombre\s+de\s+sets?|total\s+sets?|\bsets?\b/i,                                 "sets"],
  // ── Basketball (non-player totals) ──
  [/nombre\s+de\s+points?|total\s+points?|points?\s+du\s+match/i,                  "match_points"],
];

function classifyBetTitle(title: string): string | null {
  for (const [re, cat] of MARKET_CAT_MAP) {
    if (re.test(title)) return cat;
  }
  return null;
}

function parseOverUnderOutcomes(
  outcomeIds: (number | string)[],
  odds: Record<string, any>,
  outcomesMeta: Record<string, any>,
): TotalsLine[] {
  const byLine = new Map<number, { over: number; under: number }>();
  for (const oId of outcomeIds) {
    const rawOdds = odds[String(oId)];
    if (rawOdds == null) continue;
    const oOdds = Number(rawOdds);
    if (oOdds < 1.01) continue;
    const label = (outcomesMeta[String(oId)]?.label ?? "").toLowerCase();
    const lineMatch = label.match(/(\d+[.,]\d+|\d+)/);
    if (!lineMatch) continue;
    const line = parseFloat(lineMatch[1].replace(",", "."));
    const isOver  = /plus\s*de|more\s*than|\bover\b|más\s*de|mais\s*de/i.test(label);
    const isUnder = /moins\s*de|less\s*than|\bunder\b|menos\s*de/i.test(label);
    if (!isOver && !isUnder) continue;
    const cur = byLine.get(line) ?? { over: 0, under: 0 };
    if (isOver  && oOdds > cur.over)  cur.over  = oOdds;
    if (isUnder && oOdds > cur.under) cur.under = oOdds;
    byLine.set(line, cur);
  }
  return [...byLine.entries()]
    .filter(([, { over, under }]) => over >= 1.01 && under >= 1.01)
    .map(([line, { over, under }]) => ({ line, over, under }));
}

function parseHandicapOutcomes(
  outcomeIds: (number | string)[],
  odds: Record<string, any>,
  outcomesMeta: Record<string, any>,
  homeName: string,
  awayName: string,
): H2HOutcome[] {
  const out: H2HOutcome[] = [];
  for (const oId of outcomeIds) {
    const rawOdds = odds[String(oId)];
    if (rawOdds == null) continue;
    const oOdds = Number(rawOdds);
    if (oOdds < 1.01) continue;
    const label = outcomesMeta[String(oId)]?.label ?? "";
    const hcapMatch = label.match(/([+-]\s*\d+[.,]?\d*)/);
    if (!hcapMatch) continue;
    const hcap = hcapMatch[1].replace(/\s/, "").replace(",", ".");
    const isHome = /[eé]quipe\s*1|\bteam\s*1\b|\(1\)|\bhome\b/i.test(label)
      || (homeName.length > 3 && label.toLowerCase().includes(homeName.slice(0, 4).toLowerCase()));
    const isAway = /[eé]quipe\s*2|\bteam\s*2\b|\(2\)|\baway\b/i.test(label)
      || (awayName.length > 3 && label.toLowerCase().includes(awayName.slice(0, 4).toLowerCase()));
    if (isHome) out.push({ name: `Home (${hcap})`, odds: oOdds });
    else if (isAway) out.push({ name: `Away (${hcap})`, odds: oOdds });
  }
  return out;
}

// ─── Player prop parsing ──────────────────────────────────────────────────────

// Winamax FR bet titles for player props (French labels)
const PROP_STAT_MAP: Array<[RegExp, string]> = [
  [/passes?\s+d[ée]cisives?/i,                    "AST"],
  [/paniers?\s+[àa]\s+3\s+points?/i,              "3PT"],
  [/pra\b|points?\s*\+?\s*rebonds?\s*\+?\s*passes?/i, "PRA"],
  [/rebonds?/i,                                    "REB"],
  [/points?\s+marqu[ée]s?|points?\s*\(NBA\)/i,    "PTS"],
  [/\bpoints?\b/i,                                 "PTS"],
];

function parsePropStat(title: string): string | null {
  for (const [re, stat] of PROP_STAT_MAP) {
    if (re.test(title)) return stat;
  }
  return null;
}

/**
 * Try to parse a non-main bet as a player prop Over/Under.
 * Winamax bet title format: "Player Name - Stat" (FR)
 * Outcome labels: "Plus de 19.5" (Over) / "Moins de 19.5" (Under)
 */
function parsePlayerPropBet(
  betTitle: string,
  outcomeIds: (number | string)[],
  odds: Record<string, any>,
  outcomesMeta: Record<string, any>,
): PlayerPropLine | null {
  // Title must contain " - " separating player from stat
  const dashIdx = betTitle.indexOf(" - ");
  if (dashIdx < 2) return null;

  const playerName = betTitle.slice(0, dashIdx).trim();
  const statPart   = betTitle.slice(dashIdx + 3).trim();
  const stat = parsePropStat(statPart);
  if (!stat || !playerName) return null;

  let line: number | null = null;
  let overOdds  = 0;
  let underOdds = 0;

  for (const oId of outcomeIds) {
    const rawOdds = odds[String(oId)];
    if (rawOdds == null) continue;
    const oOdds = Number(rawOdds);
    if (oOdds < 1.01) continue;

    const label: string = (outcomesMeta[String(oId)]?.label ?? "").toLowerCase();
    // Extract line value: "Plus de 19.5" → 19.5
    const lineMatch = label.match(/(\d+[.,]\d+)/);
    if (!lineMatch) continue;
    const thisLine = parseFloat(lineMatch[1].replace(",", "."));

    if (label.includes("plus") || label.includes("over") || label.includes("+") || label.includes("más") || label.includes("mais")) {
      if (overOdds === 0 || oOdds > overOdds) { overOdds = oOdds; line = thisLine; }
    } else if (label.includes("moins") || label.includes("under") || label.includes("menos")) {
      if (underOdds === 0 || oOdds > underOdds) { underOdds = oOdds; }
    }
  }

  if (!line || overOdds < 1.01 || underOdds < 1.01) return null;
  return { player: playerName, stat, line, over: overOdds, under: underOdds };
}

/** Parse live/prematch events from the accumulated Winamax Socket.IO state */
function parseWinamaxWsState(state: Record<string, any>, sport: Sport, isLive: boolean, logger: (msg: string) => void): ScrapedEvent[] {
  const events: ScrapedEvent[] = [];
  const targetSportId = SPORT_IDS[sport];

  const matches: Record<string, any> = state.matches ?? {};
  const bets: Record<string, any> = state.bets ?? {};
  const odds: Record<string, any> = state.odds ?? {};
  const outcomesMeta: Record<string, any> = state.outcomes ?? {};

  // Pre-index bets by matchId so we can find all bets for a match
  const betsByMatch = new Map<string, string[]>();
  for (const [betId, bet] of Object.entries(bets)) {
    const matchId = String(bet?.matchId ?? bet?.match_id ?? "");
    if (!matchId) continue;
    const list = betsByMatch.get(matchId) ?? [];
    list.push(betId);
    betsByMatch.set(matchId, list);
  }

  // Log sport ID mapping from state.sports (first time only)
  if (state.sports && typeof state.sports === "object") {
    const sportsInfo = Object.entries(state.sports as Record<string, any>)
      .slice(0, 10)
      .map(([id, s]: [string, any]) => `${id}=${s?.name ?? s?.sportName ?? "?"}`)
      .join(", ");
    logger(`WS sports: ${sportsInfo}`);
  }

  for (const [, match] of Object.entries(matches)) {
    if (!match || typeof match !== "object") continue;
    if (match.sportId !== targetSportId) continue;
    // Q6: accept multiple live status variants used by different Winamax API versions
    const matchIsLive = match.status === "LIVE" || match.is_live === true || match.match_status === 1;
    if (isLive && !matchIsLive) continue;
    if (!isLive && matchIsLive) continue; // excluye live; acepta PREMATCH/NotStarted/SCHEDULED/etc.
    if (match.available === false || match.available === 0) continue;

    const title: string = match.title ?? "";
    if (!title) continue;

    const mainBetId = match.mainBetId;
    const bet = bets[String(mainBetId)];
    if (!bet || !Array.isArray(bet.outcomes) || bet.outcomes.length < 2) continue;

    const template: string = bet.template ?? "";
    const parts = title.split(" - ");
    const homeName = parts[0]?.trim() ?? "1";
    const awayName = parts[1]?.trim() ?? "2";

    const h2h: H2HOutcome[] = [];
    for (let i = 0; i < bet.outcomes.length; i++) {
      const oId = bet.outcomes[i];
      const oOdds = odds[String(oId)];
      if (oOdds == null || Number(oOdds) < 1.01) continue;

      const labelFromMeta: string = outcomesMeta[String(oId)]?.label ?? "";
      let name: string;
      if (labelFromMeta) {
        name = labelFromMeta;
      } else if (template === "3way") {
        name = i === 0 ? homeName : i === 1 ? "X" : awayName;
      } else if (template === "2way") {
        name = i === 0 ? homeName : awayName;
      } else {
        name = String(i + 1);
      }
      h2h.push({ name, odds: Number(oOdds) });
    }

    const eventKey = buildEventKey(sport, title, undefined);
    const tournamentId: number = match.tournamentId;
    const league: string = tournamentId ? `tournament_${tournamentId}` : "";

    if (h2h.length >= 2) {
      events.push({
        bookmaker: "winamax", sport, eventKey, eventName: title,
        league, isLive, market: "h2h", outcomes: h2h,
      });
    }

    // ── Secondary markets (ALL sports) ──────────────────────────────────────
    // Corners, cards, handicap, O/U goals, player props — any bet that's not the main H2H
    const matchId = String(match.matchId ?? match.id ?? "");
    const secondaryBetIds = new Set<string>([
      ...((match.bets ?? match.betIds ?? []) as (number | string)[]).map(String),
      ...(matchId ? betsByMatch.get(matchId) ?? [] : []),
    ]);
    secondaryBetIds.delete(String(mainBetId));

    // Fallback: scan all bets in state when match.bets is absent
    if (secondaryBetIds.size === 0 && matchId) {
      for (const [betId, b] of Object.entries(bets)) {
        if (String(b?.matchId ?? b?.match_id) === matchId && betId !== String(mainBetId)) {
          secondaryBetIds.add(betId);
        }
      }
    }

    // Accumulate parsed outcomes by market key
    const marketAcc = new Map<string, TotalsLine[] | H2HOutcome[] | PlayerPropLine[]>();

    for (const betId of secondaryBetIds) {
      const b = bets[betId];
      if (!b || !Array.isArray(b.outcomes) || b.outcomes.length < 2) continue;
      const betTitle: string = b.betTitle ?? b.title ?? b.label ?? b.name ?? "";
      if (!betTitle) continue;

      // 1. Try player prop first ("Player Name - Stat" format, any sport)
      const prop = parsePlayerPropBet(betTitle, b.outcomes, odds, outcomesMeta);
      if (prop) {
        if (!marketAcc.has("player_props")) marketAcc.set("player_props", []);
        (marketAcc.get("player_props") as PlayerPropLine[]).push(prop);
        continue;
      }

      // 2. Classify by bet title (corners, cards, goals, handicap, tennis, etc.)
      const cat = classifyBetTitle(betTitle);
      if (!cat) continue;

      if (cat === "handicap") {
        const hOuts = parseHandicapOutcomes(b.outcomes, odds, outcomesMeta, homeName, awayName);
        if (hOuts.length >= 2) {
          if (!marketAcc.has("handicap")) marketAcc.set("handicap", []);
          (marketAcc.get("handicap") as H2HOutcome[]).push(...hOuts);
        }
      } else {
        // Over/Under market
        const lines = parseOverUnderOutcomes(b.outcomes, odds, outcomesMeta);
        if (lines.length > 0) {
          if (!marketAcc.has(cat)) marketAcc.set(cat, []);
          (marketAcc.get(cat) as TotalsLine[]).push(...lines);
        }
      }
    }

    // Emit one ScrapedEvent per market key
    for (const [mkt, outs] of marketAcc) {
      events.push({
        bookmaker: "winamax", sport, eventKey, eventName: title,
        league, isLive, market: mkt, outcomes: outs,
      });
    }

    if (secondaryBetIds.size > 0) {
      const mkts = [...marketAcc.keys()].join(", ") || "none";
      logger(`${title}: ${secondaryBetIds.size} secondary bets → markets: ${mkts}`);
    }
  }
  return events;
}

/** Resultado de la espera de datos Winamax */
type WsWaitResult =
  | "ws_data"    // wsState.matches tiene partidos → usar parseWinamaxWsState
  | "rest_data"  // datos REST capturados vía XHR → usar captured
  | "ws_empty"   // WS conectó pero no hay partidos (estado legítimo fuera de temporada)
  | "timeout";   // Sin WS ni REST en maxMs → posible bloqueo

/**
 * Espera orientada a eventos: sale en cuanto hay datos WS o REST, con timeout máximo.
 * Distingue "WS bloqueado" (timeout sin msgs) de "WS vacío" (msgs pero sin partidos).
 */
async function waitForWsOrRest(
  page: Page,
  wsState: Record<string, any>,
  wsMessages: Array<{ url: string; payload: string }>,
  captured: Array<{ url: string; data: any }>,
  maxMs: number = 12_000
): Promise<WsWaitResult> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (Object.keys(wsState.matches ?? {}).length > 0) return "ws_data";
    if (captured.length > 0) return "rest_data";
    if (page.isClosed()) return "timeout";
    await new Promise<void>((r) => setTimeout(r, 400));
  }
  // Expiró el timeout — ¿al menos llegaron frames WS?
  return wsMessages.length > 0 ? "ws_empty" : "timeout";
}

export class WinamaxScraper extends BaseScraper {
  readonly name = "winamax";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "VOLLEYBALL"];

  // One page load per cycle: WS sends ALL sports data at once.
  // Live: load /paris-sportifs/live → WS sends all live matches.
  // Prematch: try /paris-sportifs/sports/1 (football, biggest prematch catalogue);
  //           if it times out fall back to homepage which still gets WS prematch data.
  private async scrapePage(isLive: boolean): Promise<ScrapedEvent[]> {
    const { page, ctx } = await browserManager.newPage();
    const captured: Array<{ url: string; data: any }> = [];
    const getApiCalls = captureJsonRequests(page);

    page.on("response", async (res: any) => {
      try {
        const u: string = res.url();
        const ct: string = res.headers()?.["content-type"] ?? "";
        if (res.status() !== 200 || !ct.includes("json")) return;
        const data = await res.json();
        if (JSON.stringify(data).length > 500) captured.push({ url: u, data });
      } catch { /* non-JSON or closed */ }
    });

    const wsMessages: Array<{ url: string; payload: string }> = [];
    const wsState: Record<string, any> = {};
    page.on("websocket", (ws: any) => {
      ws.on("framereceived", (frame: any) => {
        const raw = frame.payload;
        const payload = typeof raw === "string" ? raw : (Buffer.isBuffer(raw) ? raw.toString("utf8") : "");
        if (payload.length > 10) {
          wsMessages.push({ url: ws.url(), payload });
          const stripped = payload.replace(/^\d+/, "");
          if (stripped.startsWith("[")) {
            try {
              const arr = JSON.parse(stripped);
              if (Array.isArray(arr) && typeof arr[0] === "string" && arr[1] !== undefined) {
                const evtName = arr[0];
                if (evtName === "m" && typeof arr[1] === "object" && arr[1] !== null) {
                  mergeWsMessage(wsState, arr[1]);
                } else if (typeof arr[1] === "object" && arr[1] !== null) {
                  // Named events: ["matches",{...}], ["bets",{...}], ["odds",{...}], etc.
                  wsState[evtName] = arr[1];
                }
              }
            } catch { /* */ }
          }
        }
      });
    });

    const events: ScrapedEvent[] = [];
    try {
      // Live: /paris-sportifs/live has WS data for ALL live sports in one shot.
      // Prematch: try Football page (biggest catalogue, WS sends all prematch too).
      const targetUrl = isLive
        ? `${BASE_FR}/paris-sportifs/live`
        : `${BASE_FR}/paris-sportifs/sports/${SPORT_IDS.FOOTBALL}`;

      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 55_000 }).catch(async (e: any) => {
        this.warn(`Goto ${targetUrl} failed (${e?.message?.slice(0, 60)}) — falling back to homepage`);
        await page.goto(`${BASE_FR}/paris-sportifs`, { waitUntil: "domcontentloaded", timeout: 40_000 });
      });
      await dismissCookies(page);
      const waitResult = await waitForWsOrRest(page, wsState, wsMessages, captured, 12_000);
      if (waitResult === "timeout") {
        this.warn(`${isLive ? "Live" : "Prematch"}: sin datos WS ni REST en 12s — posible bloqueo de Winamax`);
      } else if (waitResult === "ws_empty") {
        this.log(`${isLive ? "Live" : "Prematch"}: WS conectó pero sin partidos (estado legítimo)`);
      }

      const wsStateKeys = Object.keys(wsState);
      const wsUrls = wsMessages.length > 0
        ? [...new Set(wsMessages.map(m => m.url))].map(u => u.slice(0, 80)).join(" | ")
        : "none";
      const sampleEvts = wsMessages.slice(0, 8).map(m => {
        const s = m.payload.replace(/^\d+/, "");
        if (s.startsWith("[")) { try { const a = JSON.parse(s); return Array.isArray(a) ? a[0] : "?"; } catch {} }
        return s.slice(0, 15);
      }).join(",");
      this.log(`WS: ${wsMessages.length} msgs, keys=[${wsStateKeys.slice(0, 10).join(",")}], evts=[${sampleEvts}], url=${wsUrls.slice(0, 100)}`);

      const matchCount = Object.keys(wsState.matches ?? {}).length;

      for (const sport of this.sports) {
        if (wsStateKeys.length > 0) {
          const wsEvents = parseWinamaxWsState(wsState, sport, isLive, (msg) => this.log(msg));
          if (wsEvents.length > 0) {
            this.log(`WS ${isLive ? "live" : "prematch"} ${sport}: ${wsEvents.length} events`);
            events.push(...wsEvents);
          } else {
            const sportId = SPORT_IDS[sport];
            const sportMatches = Object.values(wsState.matches ?? {}).filter(
              (m: any) => m?.sportId === sportId && (isLive ? m?.status === "LIVE" : m?.status === "PREMATCH")
            ).length;
            this.warn(`WS 0 events for ${sport} (id=${sportId}, total=${matchCount}, ${isLive ? "live" : "pre"}=${sportMatches})`);
            // Fallback: try parseWinamaxData on wsState itself (handles sports/competitions/matches structure)
            const fallback = parseWinamaxData(wsState, sport, isLive, "ws-state");
            if (fallback.length > 0) {
              this.log(`WS fallback ${sport}: ${fallback.length} events from wsState structure`);
              events.push(...fallback);
            }
          }
        }
        // Also try any XHR data
        for (const { data } of captured) {
          const parsed = parseWinamaxData(data, sport, isLive, "");
          if (parsed.length > 0) events.push(...parsed);
        }
      }

      if (events.length === 0 && wsStateKeys.length === 0) {
        await logPageState(page, this.name, getApiCalls());
      } else if (events.length > 0) {
        browserManager.recordSuccess();
        this.log(`${isLive ? "Live" : "Prematch"} total: ${events.length} events across ${this.sports.join("/")}`);
      }
    } catch (err: any) {
      const isCrash =
        String(err?.message).includes("closed") ||
        String(err?.message).includes("crashed") ||
        String(err?.message).includes("disconnected");
      if (isCrash) {
        browserManager.recordCrash();
        await browserManager.shutdown();
      }
      this.warn(`${isLive ? "live" : "prematch"} page failed`, err);
    } finally {
      await ctx.close().catch(() => {});
    }
    return events;
  }

  // Prematch: each sport's WS only sends that sport's data, so we load per-sport.
  private async scrapePrematchSport(sport: Sport): Promise<ScrapedEvent[]> {
    const { page, ctx } = await browserManager.newPage();
    const captured: Array<{ url: string; data: any }> = [];
    const wsState: Record<string, any> = {};
    const wsMessages: Array<{ url: string; payload: string }> = [];

    page.on("response", async (res: any) => {
      try {
        const ct: string = res.headers()?.["content-type"] ?? "";
        if (res.status() !== 200 || !ct.includes("json")) return;
        const data = await res.json();
        if (JSON.stringify(data).length > 500) captured.push({ url: res.url(), data });
      } catch { /* */ }
    });

    page.on("websocket", (ws: any) => {
      ws.on("framereceived", (frame: any) => {
        const raw = frame.payload;
        const payload = typeof raw === "string" ? raw : (Buffer.isBuffer(raw) ? raw.toString("utf8") : "");
        if (payload.length > 10) {
          wsMessages.push({ url: ws.url(), payload });
          const stripped = payload.replace(/^\d+/, "");
          if (stripped.startsWith("[")) {
            try {
              const arr = JSON.parse(stripped);
              if (Array.isArray(arr) && typeof arr[0] === "string" && arr[1] !== undefined) {
                const evtName = arr[0];
                if (evtName === "m" && typeof arr[1] === "object" && arr[1] !== null) {
                  mergeWsMessage(wsState, arr[1]);
                } else if (typeof arr[1] === "object" && arr[1] !== null) {
                  wsState[evtName] = arr[1];
                }
              }
            } catch { /* */ }
          }
        }
      });
    });

    const events: ScrapedEvent[] = [];
    try {
      const url = `${BASE_FR}/paris-sportifs/sports/${SPORT_IDS[sport]}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 55_000 }).catch(async (e: any) => {
        this.warn(`Prematch ${sport} goto failed (${e?.message?.slice(0, 60)}) — skip`);
      });
      await dismissCookies(page);
      const waitResult = await waitForWsOrRest(page, wsState, wsMessages, captured, 12_000);
      if (waitResult === "timeout") {
        this.warn(`Prematch ${sport}: sin datos WS ni REST en 12s — posible bloqueo`);
      }

      const wsStateKeys = Object.keys(wsState);
      if (wsStateKeys.length > 0) {
        const wsEvents = parseWinamaxWsState(wsState, sport, false, (msg) => this.log(msg));
        if (wsEvents.length > 0) {
          this.log(`WS prematch ${sport}: ${wsEvents.length} events`);
          events.push(...wsEvents);
        }
      }
      for (const { data } of captured) {
        const parsed = parseWinamaxData(data, sport, false, "");
        if (parsed.length > 0) events.push(...parsed);
      }
      if (events.length === 0) {
        const wsKeys = Object.keys(wsState).slice(0, 10).join(",");
        const fallback = parseWinamaxData(wsState, sport, false, "ws-state");
        if (fallback.length > 0) {
          this.log(`WS prematch ${sport} fallback: ${fallback.length} events from wsState`);
          events.push(...fallback);
        } else {
          this.warn(`Prematch ${sport}: 0 events (WS keys: ${wsKeys || "none"})`);
        }
      } else {
        browserManager.recordSuccess();
      }
    } catch (err: any) {
      const isCrash =
        String(err?.message).includes("closed") ||
        String(err?.message).includes("crashed") ||
        String(err?.message).includes("disconnected");
      if (isCrash) {
        browserManager.recordCrash();
        await browserManager.shutdown();
      }
      this.warn(`Prematch ${sport} failed`, err);
    } finally {
      await ctx.close().catch(() => {});
    }
    return events;
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    return this.scrapePage(true);
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) {
      all.push(...await this.scrapePrematchSport(sport));
    }
    return all;
  }
}
