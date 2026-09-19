/**
 * Winamax España — Playwright XHR interception scraper.
 *
 * Winamax uses an SPA that handles routing client-side. Server-side navigation
 * to sport URLs triggers a server redirect back to /apuestas-deportivas/.
 * Solution: load the SPA once, then click sport navigation links in the DOM
 * to trigger client-side routing + XHR data loading.
 *
 * Winamax blocks page.request.get() (WAF → 403/404).
 */

import { BaseScraper } from "./base";
import { browserManager, dismissCookies, captureJsonRequests, logPageState } from "./playwright-base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine, PlayerPropLine } from "../types";
import type { Page } from "playwright";

const BASE_ES = "https://www.winamax.es";

// WS sport IDs for winamax.es — verified from WS dump (update if logs show different mapping).
// Live page log line "WS sports: N=Sport..." reveals the actual IDs on each deploy.
const SPORT_IDS: Partial<Record<Sport, number>> = {
  FOOTBALL:         1,
  TENNIS:           5,
  BASKETBALL:       2,
  BASEBALL:         3,
  ICEHOCKEY:        4,
  AMERICANFOOTBALL: 16,
};

const SPORT_HREF_PATTERNS: Partial<Record<Sport, string[]>> = {
  FOOTBALL:         ["/apuestas-deportivas/sports/1", "/apuestas-deportivas/sports/1/"],
  TENNIS:           ["/apuestas-deportivas/sports/5", "/apuestas-deportivas/sports/5/"],
  BASKETBALL:       ["/apuestas-deportivas/sports/2", "/apuestas-deportivas/sports/2/"],
  BASEBALL:         ["/apuestas-deportivas/sports/3", "/apuestas-deportivas/sports/3/"],
  ICEHOCKEY:        ["/apuestas-deportivas/sports/4", "/apuestas-deportivas/sports/4/"],
  AMERICANFOOTBALL: ["/apuestas-deportivas/sports/16", "/apuestas-deportivas/sports/16/"],
};

// Fallback text-based click labels (French site)
const SPORT_LINK_TEXTS: Partial<Record<Sport, string[]>> = {
  FOOTBALL:         ["football", "foot"],
  TENNIS:           ["tennis"],
  BASKETBALL:       ["basket", "basketball"],
  BASEBALL:         ["baseball", "base-ball"],
  ICEHOCKEY:        ["hockey sur glace", "hockey glace", "hockey"],
  AMERICANFOOTBALL: ["football américain", "american football"],
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
    // Skip virtual/accumulator events (MultiFoot, MultiSport) - not real matches
    if (/multi.?foot|multi.?sport|multi.?match|multibet/i.test(eventName) || /multi.?foot|multi.?sport/i.test(league)) continue;
    // Skip events where home == away
    if (home && away && home.toLowerCase() === away.toLowerCase()) continue;

    const rawStartTime = match.matchStart ?? match.date ?? match.startDate;
    const startTime = rawStartTime ? new Date(typeof rawStartTime === "number" ? rawStartTime * 1000 : rawStartTime) : (isLive ? new Date() : undefined);
    const eventKey = buildEventKey(sport, eventName, startTime);

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
          events.push({ bookmaker: "winamax", sport, eventKey, eventName, league, isLive, market: "h2h", outcomes: h2h, startTime });
        }
      } else if (title.includes("total") || title.includes("over") || title.includes("plus/moins") || title.includes("más/menos")) {
        const byLine = new Map<number, TotalsLine>();
        for (const c of choices) {
          const lbl: string = (c.label ?? c.name ?? "").toLowerCase();
          const odds = typeof c.odds === "number" ? c.odds : parseFloat(c.odds ?? c.price ?? "0");
          const lm = lbl.match(/(\d+[.,]\d+)/);
          if (!lm || odds < 1.01) continue;
          const line = parseFloat(lm[1].replace(",", "."));
          const isOver  = lbl.includes("más") || lbl.includes("over")
            || (lbl.includes("plus") && !lbl.includes("au plus"));   // "au plus" = at most = Under
          const isUnder = lbl.includes("menos") || lbl.includes("under")
            || (lbl.includes("moins") && !lbl.includes("au moins"))  // "au moins" = at least = Over
            || lbl.includes("au plus");
          // "+1.5" / "-1.5" notation when no keyword present — require explicit sign
          const hasPlusSuffix  = !isOver && !isUnder && /^\+\d/.test(lbl.trim());
          const hasMinusSuffix = !isOver && !isUnder && lbl.trim().startsWith("-");
          const entry = byLine.get(line) ?? { line, over: 0, under: 0 };
          if (isOver  || hasPlusSuffix)  entry.over  = odds;
          else if (isUnder || hasMinusSuffix) entry.under = odds;
          // else: unrecognized label — skip rather than guessing
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

/** Merge all Socket.IO "m" / "message" messages into a single state object */
function mergeWsMessage(state: Record<string, any>, msg: Record<string, any>): void {
  for (const [k, v] of Object.entries(msg)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof state[k] === "object" && !Array.isArray(state[k])) {
      mergeWsMessage(state[k], v as Record<string, any>);
    } else {
      state[k] = v;
    }
  }
}

/**
 * Returns the effective matches/bets/odds dicts from wsState, handling
 * both the old format (fields at root) and the new format where Winamax
 * sends event name "message" instead of "m" (fields nested under state.message).
 */
function resolveWsStateRoot(state: Record<string, any>): Record<string, any> {
  if (state.matches != null) return state;
  // Winamax changed WS event name from "m" to "message" — check nested
  if (state.message != null && typeof state.message === "object" && state.message.matches != null) {
    return state.message as Record<string, any>;
  }
  return state;
}

// ─── Secondary market parsing (corners, cards, handicap, O/U goals, player props) ────

// Maps French bet titles to canonical market keys
const MARKET_CAT_MAP: Array<[RegExp, string]> = [
  // ── H2H secondary (binary/ternary: btts, double chance) ──
  [/les\s+deux\s+[eé]quipes?\s+marquent?|ambos?\s+(?:equipos?\s+)?(?:anotan?|marcan?)|both\s+teams?\s+score|\bbtts\b/i, "btts"],
  [/double\s+chance|doble\s+(?:oportunidad|chance)/i,                         "double_chance"],
  // ── Handicap ──
  [/h[aá]ndicap\s+asi[aá]tico|asian\s+handicap|handicap\s+asiatique/i,       "asian_handicap"],
  [/handicap|hándicap|spread/i,                                               "handicap"],
  // ── Corners ──
  [/córneres?|corners?|coups?\s+de\s+coin/i,                                  "corners"],
  // ── Cards (specific first, generic fallback last) ──
  [/tarjetas?\s+amarillas?|cartons?\s+jaunes?/i,                              "yellow_cards"],
  [/tarjetas?\s+rojas?|cartons?\s+rouges?/i,                                  "red_cards"],
  [/tarjetas?\s+(?:totales?|del\s+partido)|total\s+tarjetas?|cartons?\s+totaux|total\s+cartons?|\btarjetas?\b|\bcartons?\b/i, "cards"],
  // ── Shots on goal ──
  [/tiros?\s+(?:a\s+puerta|totales?)|remates?\s+(?:a\s+puerta|totales?)|tirs?\s+(?:au\s+but|totaux)/i, "shots"],
  // ── Half goals ──
  [/primer\s+(?:tiempo|per[ií]odo)|primera\s+(?:mitad|parte)|(?:1[eè]re?|premi[eè]re?)\s*mi[\s-]?temps|mi[\s-]?temps\s+(?:1|premi[eè]re?)|mi[\s-]?temps\s*[-:]\s*nombre|mi[\s-]?temps/i, "h1_goals"],
  [/segundo\s+(?:tiempo|per[ií]odo)|segunda\s+(?:mitad|parte)|(?:2[eè]me?|deuxi[eè]me?)\s*mi[\s-]?temps/i, "h2_goals"],
  // ── Basketball quarter/half totals (gated by BASKETBALL_ONLY_CATS) ──
  [/primer\s+cuarto|1[eè]r?\s*quart(?:-?temps)?|1st\s+quarter/i,  "q1_points"],
  [/segundo\s+cuarto|2[eè]m?e?\s*quart(?:-?temps)?|2nd\s+quarter/i, "q2_points"],
  [/tercer\s+cuarto|3[eè]m?e?\s*quart(?:-?temps)?|3rd\s+quarter/i, "q3_points"],
  [/cuarto\s+cuarto|4[eè]m?e?\s*quart(?:-?temps)?|4th\s+quarter/i, "q4_points"],
  [/primera?\s+mitad(?:\s+puntos)?|1[eè]re?\s*mi-?temps(?:\s+points?)?|half(?:time)?\s+points?|puntos?\s+1[aª]\s*(?:mitad|parte)/i, "h1_points"],
  [/segunda\s+mitad(?:\s+puntos)?|2[eè]m?e?\s*mi-?temps(?:\s+points?)?|puntos?\s+2[aª]\s*(?:mitad|parte)/i, "h2_points"],
  // ── Goals (full match) ──
  [/\bgoles?|total\s+(?:de\s+)?goles?|n\u00famero\s+de\s+goles?|nombre\s+de\s+buts?|total\s+buts?|\bbuts?\b/i, "goals"],
  // ── Tennis / Padel ──
  [/\baces?\b/i,                                                                    "aces"],
  [/dobles?\s*faltas?|doubles?\s*fautes?/i,                                   "double_faults"],
  // Set winners (must come BEFORE generic "games"/"sets" patterns)
  [/gagnant\s+du\s+(?:1er?|premier)\s*set|ganador\s+del\s+(?:1er?|primer)\s*set/i,  "s1_h2h"],
  [/gagnant\s+du\s+(?:2[e\u00e8]m?e?|deuxi[e\u00e8]me?)\s*set|ganador\s+del\s+(?:2[o\u00ba]?|segundo)\s*set/i, "s2_h2h"],
  [/gagnant\s+du\s+(?:3[e\u00e8]m?e?|troisi[e\u00e8]me?)\s*set|ganador\s+del\s+(?:3er?|tercer)\s*set/i, "s3_h2h"],
  // Per-set game O/U (before generic "games")
  [/(?:1er?|premier)\s*set[^a-z]*(?:juegos?|jeux)|set\s*[-\s]*1\b[^a-z]*(?:juegos?|jeux)/i, "s1_games"],
  [/(?:2[e\u00e8]m?e?|deuxi[e\u00e8]me?|segundo)\s*set[^a-z]*(?:juegos?|jeux)|set\s*[-\s]*2\b[^a-z]*(?:juegos?|jeux)/i, "s2_games"],
  [/(?:3[e\u00e8]m?e?|troisi[e\u00e8]me?|tercer)\s*set[^a-z]*(?:juegos?|jeux)|set\s*[-\s]*3\b[^a-z]*(?:juegos?|jeux)/i, "s3_games"],
  // Tie-break
  [/tie[\s-]?break/i,                                                          "tie_break"],
  // Generic match totals
  [/juegos?|n\u00famero\s+de\s+juegos?|nombre\s+de\s+jeux|\bjeux\b/i,          "games"],
  [/n\u00famero\s+de\s+sets?|total\s+(?:de\s+)?sets?|\bsets?\b/i,              "sets"],
  // ── Basketball (non-player totals) ──
  // ── Basketball quarter/period extra variants (Q1–Q4, period) ──
  [/\bQ1\b|quart[-\s]?1\b|1[eè]re?\s+p[eé]riode|1st\s+period/i,  "q1_points"],
  [/\bQ2\b|quart[-\s]?2\b|2[eè]m?e?\s+p[eé]riode|2nd\s+period/i, "q2_points"],
  [/\bQ3\b|quart[-\s]?3\b|3[eè]m?e?\s+p[eé]riode|3rd\s+period/i, "q3_points"],
  [/\bQ4\b|quart[-\s]?4\b|4[eè]m?e?\s+p[eé]riode|4th\s+period/i, "q4_points"],  [/puntos?\s+(?:del\s+partido|totales?)|total\s+(?:de\s+)?puntos?|n\u00famero\s+de\s+puntos?|nombre\s+(?:total\s+)?de\s+points?|total\s+des\s+points?|total\s+points?/i, "match_points"],
  // ── Baseball ──
  [/jonrones?\s+totales?|total\s+jonrones?|home\s+runs?\s+totales?|home\s+runs?/i, "home_runs"],
  [/carreras?\s+totales?|total\s+carreras?|n\u00famero\s+de\s+carreras?|total\s+runs?|\bruns?\b/i, "runs"],
  // ── Rugby / American Football ──
  [/ensayos?\s+totales?|total\s+ensayos?|nombre\s+d[e']?essais?|\bessais?\b/i, "tries"],
  [/touchdowns?\s+totales?|total\s+touchdowns?/i,                             "touchdowns"],
  // ── Baseball F5 (primeras 5 entradas / 5 premières manches) ──
  [/5\s*(?:premi[eè]res?\s+)?manches?.*(?:vainqueur|winner|ganador)|(?:vainqueur|winner|ganador).*5\s*(?:premi[eè]res?\s+)?manches?|f5\s+(?:winner|moneyline)|primeras?\s*5\s*entradas?.*ganador|ganador.*primeras?\s*5\s*entradas?/i, "h1_h2h"],
  [/5\s*(?:premi[eè]res?\s+)?manches?.*h[aá]ndicap|h[aá]ndicap.*5\s*(?:premi[eè]res?\s+)?manches?|f5\s+h[aá]ndicap|primeras?\s*5\s*entradas?.*h[aá]ndicap/i, "h1_handicap"],
  [/5\s*(?:premi[eè]res?\s+)?manches?.*(?:carreras?|runs?|total)|(?:carreras?|runs?|total).*5\s*(?:premi[eè]res?\s+)?manches?|f5\s+(?:carreras?|runs?|total)|primeras?\s*5\s*entradas?.*(?:carreras?|total)/i, "h1_runs"],
  // ── Ice Hockey ──
  [/nombre\s+de\s+(?:tirs?|lancers?)|tirs?\s+hockey|but[s]?\s+(?:encaiss[eé]s?|marqu[eé]s?)/i, "shots"],
];

const TENNIS_ONLY_CATS = new Set([
  "aces", "double_faults", "games", "sets",
  "s1_h2h", "s2_h2h", "s3_h2h",
  "s1_games", "s2_games", "s3_games",
  "tie_break",
]);
// Quarter/half point markets apply to basketball AND American football (NFL)
const QUARTER_SPORTS = new Set(["BASKETBALL", "AMERICANFOOTBALL"]);
const QUARTER_POINT_CATS = new Set(["q1_points", "q2_points", "q3_points", "q4_points", "h1_points", "h2_points"]);
// h1_goals/h2_goals must not match for basketball or NFL — those halftime markets should be h1_points/h2_points
const GOALS_HALF_EXCLUDED_SPORTS = new Set(["BASKETBALL", "AMERICANFOOTBALL"]);

function classifyBetTitle(title: string, sport: string): string | null {
  for (const [re, cat] of MARKET_CAT_MAP) {
    if (TENNIS_ONLY_CATS.has(cat) && sport !== "TENNIS") continue;
    if (QUARTER_POINT_CATS.has(cat) && !QUARTER_SPORTS.has(sport)) continue;
    if (cat === "h1_goals" || cat === "h2_goals") {
      if (GOALS_HALF_EXCLUDED_SPORTS.has(sport)) continue;
    }
    if (re.test(title)) return cat;
  }
  return null;
}

function parseOverUnderOutcomes(
  outcomeIds: (number | string)[],
  odds: Record<string, any>,
  outcomesMeta: Record<string, any>,
  debugTag?: string,
): TotalsLine[] {
  const byLine = new Map<number, { over: number; under: number }>();
  for (const oId of outcomeIds) {
    const rawOdds = odds[String(oId)];
    if (rawOdds == null) continue;
    const oOdds = Number(rawOdds);
    if (oOdds < 1.01) continue;
    const rawLabel: string = outcomesMeta[String(oId)]?.label ?? "";
    const label = rawLabel.toLowerCase();
    const lineMatch = label.match(/(\d+[.,]\d+|\d+)/);
    if (!lineMatch) continue;
    const line = parseFloat(lineMatch[1].replace(",", "."));
    const isOver  = /plus\s*de|more\s*than|\bover\b|más\s*de|mais\s*de/i.test(label)
      || (!(/moins\s*de|less\s*than|\bunder\b|menos\s*de/i.test(label)) && /^\+/.test(label.trim()));
    const isUnder = /moins\s*de|less\s*than|\bunder\b|menos\s*de/i.test(label)
      || (!(/plus\s*de|more\s*than|\bover\b|más\s*de|mais\s*de/i.test(label)) && /^-/.test(label.trim()));
    if (debugTag) {
      console.log(`[wm-ou-debug] ${debugTag} oId=${oId} label="${rawLabel}" odds=${oOdds} isOver=${isOver} isUnder=${isUnder}`);
    }
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

// Simple H2H parser for set winners, tie-break, F5 winner — label=name, no handicap number needed
function parseSimpleH2HOutcomes(
  outcomeIds: (number | string)[],
  odds: Record<string, any>,
  outcomesMeta: Record<string, any>,
): H2HOutcome[] {
  const out: H2HOutcome[] = [];
  for (const oId of outcomeIds) {
    const rawOdds = odds[String(oId)];
    if (rawOdds == null) continue;
    const oOdds = Number(rawOdds);
    if (oOdds < 1.01) continue;
    const name: string = outcomesMeta[String(oId)]?.label ?? String(oId);
    if (!name) continue;
    out.push({ name, odds: oOdds });
  }
  return out;
}

const H2H_SECONDARY_CATS = new Set(["s1_h2h", "s2_h2h", "s3_h2h", "tie_break", "h1_h2h", "btts", "double_chance"]);

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
    const isHome = /equipo\s*1|\blocal\b|[eé]quipe\s*1|\bteam\s*1\b|\(1\)|\bhome\b/i.test(label)
      || (homeName.length > 3 && label.toLowerCase().includes(homeName.slice(0, 4).toLowerCase()));
    const isAway = /equipo\s*2|\bvisitante\b|[eé]quipe\s*2|\bteam\s*2\b|\(2\)|\baway\b/i.test(label)
      || (awayName.length > 3 && label.toLowerCase().includes(awayName.slice(0, 4).toLowerCase()));
    if (isHome) out.push({ name: `Home (${hcap})`, odds: oOdds });
    else if (isAway) out.push({ name: `Away (${hcap})`, odds: oOdds });
  }
  return out;
}

// ─── Player prop parsing ──────────────────────────────────────────────────────

// Winamax ES player prop patterns — Spanish primary, French/English fallbacks
const PROP_STAT_MAP: Array<[RegExp, string]> = [
  // ── Basketball (specific combos first) ──
  [/triple[-\s]?double/i,                                       "TRIPLE_DOUBLE"],
  [/double[-\s]?double/i,                                       "DOUBLE_DOUBLE"],
  [/pra\b|points?\s*\+?\s*rebonds?\s*\+?\s*passes?/i,           "PRA"],
  [/asistencias?|passes?\s+d[ée]cisives?/i,                     "AST"],
  [/triples?|canastas?\s+de\s+3|paniers?\s+[àa]\s+3\s+points?/i, "3PT"],
  [/robos?|ballons?\s+vol[eé]s?|steals?/i,                      "STL"],
  [/tapones?|\bcontres?\b|blocks?/i,                             "BLK"],
  [/p[eé]rdidas?(?:\s+de\s+bal[oó]n)?|pertes?\s+de\s+balle?|turnovers?/i, "TOV"],
  [/rebotes?|rebonds?/i,                                          "REB"],
  [/puntos?\s+(?:anotados?|marcados?)|points?\s+marqu[ée]s?|points?\s*\(NBA\)|points?\s+NBA/i, "PTS"],
  // ── Football (soccer) ──
  [/tiros?\s+(?:a\s+puerta|totales?)|remates?\s+(?:a\s+puerta|totales?)|tirs?\s+(?:cadr[eé]s?|au\s+but)|tirs?\s+totaux/i, "shots"],
  [/\bgoles?\s*(?:marcados?|del\s+jugador)?|\bbuts?\s*(?:marqu[eé]s?|du\s+joueur)?|\bbuteur/i, "goals"],
  [/pases?\s+(?:totales?|clave|claves?)|passes?\s+(?:totales?|cl[ée]s?|d[eé]cisives?)/i, "passes"],
  [/tarjetas?(?:\s+del\s+jugador)?|cartons?(?:\s+du\s*joueur)?/i, "player_cards"],
  [/d[ée]gagements?|t[aê]tes?/i,                        "duels"],
  // ── Tennis ──
  [/\baces?\b/i,                                        "aces"],
  [/dobles?\s*faltas?|doubles?\s*fautes?/i,            "double_faults"],
  [/juegos?\s+(?:ganados?)?|jeux?\s+(?:gagn[eé]s?|remport[eé]s?)?/i, "games_won"],
  [/sets?\s+(?:gagn[eé]s?|remport[eé]s?)?/i,           "sets_won"],
  // ── Baseball ──
  [/home\s+runs?|jonrones?/i,                           "HR"],
  [/bases?\s+vol[eé]es?|stolen\s+bases?/i,              "SB"],
  [/retraits?\s+(?:au\s+bâton|sur\s+prises?)|strikeouts?/i, "K"],
  [/\bhits?\b/i,                                        "H"],
  [/points?\s+(?:produits?|impuls[eé]s?)|rbis?/i,       "RBI"],
  [/\bruns?\b/i,                                        "runs"],
  // ── American football ──
  [/yardas?\s+(?:de\s+passe|passantes?|a[eé]riennes?)/i, "pass_yds"],
  [/yardas?\s+(?:terrestres?|au\s+sol|courues?)/i,       "rush_yds"],
  [/yardas?\s+(?:de\s+r[eé]ception|re[çc]ues?)/i,       "rec_yds"],
  [/pases?\s+completados?|passes?\s+complet[eé]es?|\bcompletions?\b/i, "pass_completions"],
  [/pases?\s+intentados?|passes?\s+tent[eé]es?|pass(?:ing)?\s+attempts?/i, "pass_attempts"],
  [/intercepciones?(?:\s+(?:de\s+pase?|defensivas?))?|interceptions?\s*(?:de\s+passe?|pass|throw)?/i, "pass_int"],
  [/field[\s_-]?goals?|goles?\s+de\s+campo/i,           "FG"],
  [/primeros?\s+downs?|first[\s_]?downs?/i,              "first_downs"],
  [/acarreos?|\bcorridas?\b|rush(?:ing)?\s+attempts?/i,  "rush_att"],
  [/sacks?\b/i,                                          "sacks"],
  [/r[eé]ceptions?/i,                                    "REC"],
  [/touchdowns?/i,                                       "TD"],
  // ── Ice hockey ──
  [/tirs?\s+(?:au\s+but|cadr[eé]s?)\s*(?:hockey)?|lancers?\s+(?:frapp[eé]s?|au\s+but)/i, "sog"],
  [/points?\s*(?:hockey|\(NHL\))/i,                      "hockey_pts"],
  // ── Rugby ──
  [/essais?/i,                                           "tries"],
  [/conversions?/i,                                      "conversions"],
  // ── Generic fallback (must come last) ──
  [/\bpoints?\b/i,                                       "PTS"],
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

  // Reject halftime/period tokens — "1ª mitad", "2ª mitad", "1er tiempo", "primera mitad" etc.
  // These are halftime goal markets, not player props; let them fall through to h1_goals/h2_goals.
  const TIME_PERIOD = /^(?:\d+[aAªoOº°]\.?\s*(?:mitad|parte|tiempo|half|cuarto|periodo)|primer(?:a)?\s*(?:mitad|parte|tiempo|half)|segund(?:a)?\s*(?:mitad|parte|tiempo|half)|tercer(?:a)?|1st\s+half|2nd\s+half|ht\b|q[1-4]\b)/i;
  if (TIME_PERIOD.test(playerName)) return null;

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

  // Support both old ("m" event → fields at root) and new ("message" event → nested)
  const root = resolveWsStateRoot(state);

  const matches: Record<string, any> = root.matches ?? {};
  const bets: Record<string, any> = root.bets ?? {};
  const odds: Record<string, any> = root.odds ?? {};
  const outcomesMeta: Record<string, any> = root.outcomes ?? {};

  // Pre-index bets by matchId so we can find all bets for a match
  const betsByMatch = new Map<string, string[]>();
  for (const [betId, bet] of Object.entries(bets)) {
    const matchId = String(bet?.matchId ?? bet?.match_id ?? "");
    if (!matchId) continue;
    const list = betsByMatch.get(matchId) ?? [];
    list.push(betId);
    betsByMatch.set(matchId, list);
  }

  // Log sport ID mapping from root.sports (first time only)
  if (root.sports && typeof root.sports === "object") {
    const sportsInfo = Object.entries(root.sports as Record<string, any>)
      .slice(0, 15)
      .map(([id, s]: [string, any]) => `${id}=${s?.sportName ?? s?.name ?? s?.label ?? "?"}`)
      .join(", ");
    logger(`WS sports: ${sportsInfo}`);
  }


  for (const [, match] of Object.entries(matches)) {
    if (!match || typeof match !== "object") continue;
    if (match.sportId !== targetSportId) continue;
    // For live scrape: accept ALL matches on the live page — Winamax sends some sports
    // (e.g. tennis) with status "PREMATCH" even when actually in-play. Since we explicitly
    // navigate to /apuestas-deportivas/live, every match in the WS state is live by definition.
    // For prematch: exclude confirmed-live matches to avoid duplicating live data.
    const matchIsLive = match.status === "LIVE"
      || match.status === "IN_PLAY"
      || match.status === "LIVE_EVENT"
      || match.status === "PLAYING"
      || match.matchStatus === "LIVE"
      || match.matchStatus === "IN_PLAY"
      || match.is_live === true
      || match.match_status === 1
      || match.isLive === true;
    if (!isLive && matchIsLive) continue; // prematch: skip known-live matches
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
      if (template === "3way") {
        name = i === 0 ? homeName : i === 1 ? "X" : awayName;
      } else if (template === "2way") {
        name = i === 0 ? homeName : awayName;
      } else if (labelFromMeta) {
        name = labelFromMeta;
      } else {
        name = String(i + 1);
      }
      h2h.push({ name, odds: Number(oOdds) });
    }

    const rawStart = match.matchStart ?? match.date ?? match.startDate ?? match.start;
    const startTime = rawStart ? new Date(typeof rawStart === 'number' ? rawStart * 1000 : rawStart) : (isLive ? new Date() : undefined);
    const eventKey = buildEventKey(sport, title, startTime);
    const tournamentId: number = match.tournamentId;
    const tournaments: Record<string, any> = root.tournaments ?? root.competitions ?? {};
    const league: string = tournaments[String(tournamentId)]?.name
      ?? tournaments[String(tournamentId)]?.title
      ?? "";

    const matchId = String(match.matchId ?? match.id ?? "");
    const sportNum = SPORT_IDS[sport];
    const winUrl = (sportNum != null && tournamentId && matchId)
      ? `https://www.winamax.es/apuestas-deportivas/sports/${sportNum}/${tournamentId}/${matchId}/`
      : undefined;

    if (h2h.length >= 2) {
      events.push({
        bookmaker: "winamax", sport, eventKey, eventName: title,
        league, isLive, market: "h2h", outcomes: h2h, startTime, url: winUrl,
      });
    }

    // ── Secondary markets (ALL sports) ──────────────────────────────────────
    // Corners, cards, handicap, O/U goals, player props — any bet that's not the main H2H
    //
    // NOTE: Match route subscriptions (42["m",{"route":"match:ID"}]) push CURRENT live prices
    // before parseWinamaxWsState is called, so wsState.bets already has up-to-date odds
    // for both live and prematch games by this point.
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

      // Skip combination bets (e.g. "Résultat et nombre de buts") — their outcomes mix
      // team-win probability into the totals odds, producing wildly inflated values.
      // Also skip per-team goal markets ("Nombre de buts de {Team}") to avoid confusing
      // individual-team totals with whole-match totals.
      const betTitleLow = betTitle.toLowerCase();
      const SKIP_COMBO = /résultat\s+(?:et|\&)\b|double\s+chance\s+(?:et|\&)\b|tiers[\s-]temps\s+avec|quart[\s-]temps\s+avec|mi[\s-]?temps\s+avec\s+le?\s+plus|(?:et|\&)\s+nombre\s+de\s+buts?|1x2\s+et|et\s+1x2/i;
      if (SKIP_COMBO.test(betTitle)) continue;
      const homeLow = homeName.toLowerCase();
      const awayLow = awayName.toLowerCase();
      // If bet title includes a significant portion of either team's name, it's per-team
      const isPerTeam =
        (homeLow.length >= 4 && betTitleLow.includes(homeLow.slice(0, 4))) ||
        (awayLow.length >= 4 && betTitleLow.includes(awayLow.slice(0, 4)));
      if (isPerTeam) continue;

      // Skip generic halftime markets ("Mi-temps" without 1ère/2ème qualifier).
      // These are ambiguous halftime O/U markets that don't map to h1_goals or h2_goals
      // and produce wrong odds when classified as full-match goals.
      if (/mi[\s-]?temps/i.test(betTitle) && !/(?:1[eè]re?|premi[eè]re?|2[eè]me?|deuxi[eè]me?)/i.test(betTitle)) continue;

      // 2. Classify by bet title (corners, cards, goals, handicap, tennis, etc.)
      const cat = classifyBetTitle(betTitle, sport);
      if (!cat) continue;

      if (cat === "handicap") {
        const hOuts = parseHandicapOutcomes(b.outcomes, odds, outcomesMeta, homeName, awayName);
        if (hOuts.length >= 2) {
          if (!marketAcc.has("handicap")) marketAcc.set("handicap", []);
          (marketAcc.get("handicap") as H2HOutcome[]).push(...hOuts);
        }
      } else if (H2H_SECONDARY_CATS.has(cat)) {
        const hOuts = parseSimpleH2HOutcomes(b.outcomes, odds, outcomesMeta);
        if (hOuts.length >= 2) {
          if (!marketAcc.has(cat)) marketAcc.set(cat, []);
          (marketAcc.get(cat) as H2HOutcome[]).push(...hOuts);
        }
      } else {
        const debugTag: string | undefined = undefined;
        let lines = parseOverUnderOutcomes(b.outcomes, odds, outcomesMeta, debugTag);

        // Log bet titles producing suspicious football goals odds (diagnostic)
        if (cat === "goals" && sport === "FOOTBALL") {
          for (const t of lines) {
            if ((t.line <= 1.5 && t.over > 2.50) || (t.line <= 2.5 && t.over > 5.00)) {
              const hex = Buffer.from(betTitle.slice(0, 15)).toString("hex");
              logger(`[FOOTBALL goals suspect] betTitle="${betTitle}" hex=${hex} line=${t.line} over=${t.over}`);
            }
          }
          // Sanity check: reject lines with physically impossible full-match football odds.
          // Halftime markets (Over 1.5 first-half ~@5) pass SKIP_COMBO but have wrong odds.
          lines = lines.filter(t =>
            !(t.line <= 0.5 && t.over > 1.50) &&
            !(t.line <= 1.5 && t.over > 2.50) &&
            !(t.line <= 2.5 && t.over > 5.00)
          );
        }

        if (lines.length > 0) {
          if (!marketAcc.has(cat)) marketAcc.set(cat, []);
          (marketAcc.get(cat) as TotalsLine[]).push(...lines);
        }
      }
    }

    // Football goals market deduplication: Winamax may emit two separate "Nombre de buts"
    // bets for the same match (one full-match, one halftime) with no "mi-temps" in the
    // halftime bet title when it is nested inside a halftime bet-group in the WS state.
    // Both end up classified as "goals", causing false middles (e.g. halftime Over 2 @3.90
    // paired with full-match Under 2.5 @2.25). For any duplicate line number, keep the
    // entry with the lowest over odds — full-match odds are always lower than halftime odds.
    if (sport === "FOOTBALL") {
      const goalsRaw = marketAcc.get("goals") as TotalsLine[] | undefined;
      if (goalsRaw && goalsRaw.length > 0) {
        const byLine = new Map<number, TotalsLine>();
        for (const t of goalsRaw) {
          const prev = byLine.get(t.line);
          if (!prev || t.over < prev.over) byLine.set(t.line, t);
        }
        marketAcc.set("goals", [...byLine.values()].sort((a, b) => a.line - b.line));
      }
    }

    // Emit one ScrapedEvent per market key
    for (const [mkt, outs] of marketAcc) {
      events.push({
        bookmaker: "winamax", sport, eventKey, eventName: title,
        league, isLive, market: mkt, outcomes: outs, url: winUrl,
      });
    }

    if (secondaryBetIds.size > 0 && marketAcc.size > 0) {
      logger(`${title}: secondary → ${[...marketAcc.keys()].join(", ")}`);
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
    // Check both root-level and nested under "message" key (Winamax format change)
    const root = resolveWsStateRoot(wsState);
    if (Object.keys(root.matches ?? {}).length > 0) return "ws_data";
    if (captured.length > 0) return "rest_data";
    if (page.isClosed()) return "timeout";
    await new Promise<void>((r) => setTimeout(r, 400));
  }
  return wsMessages.length > 0 ? "ws_empty" : "timeout";
}

/**
 * Auto-scroll para activar lazy-loading de mercados secundarios en Winamax.
 * El SPA suscribe al WS por tramos visibles — hacer scroll empuja corners/handicap/goles.
 * Registra el bet count antes y después para detectar si el scroll trajo datos nuevos.
 */
async function autoScrollForSecondaryMarkets(
  page: Page,
  wsState: Record<string, any>,
  logger: (msg: string) => void,
  scrollSteps = 8,
  stepPxs = 1200,
  pauseMs = 2000,
): Promise<void> {
  const betsBefore = Object.keys(wsState.bets ?? {}).length;
  for (let i = 0; i < scrollSteps; i++) {
    if (page.isClosed()) break;
    await page.evaluate((px: number) => window.scrollBy(0, px), stepPxs).catch(() => {});
    await new Promise<void>((r) => setTimeout(r, pauseMs));
  }
  const betsAfter = Object.keys(wsState.bets ?? {}).length;
  logger(`scroll: bets ${betsBefore} → ${betsAfter} (+${betsAfter - betsBefore})`);
}

export class WinamaxScraper extends BaseScraper {
  readonly name = "winamax";
  // Confirmed IDs from WS: Football=1, Basketball=2, Baseball=3, IceHockey=4, Tennis=5, Handball=6, AmericanFootball=16, Specials=18
  // NOTE: ID 18 = Especiales (Specials), not American Football. AmericanFootball is ID 16.
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "BASEBALL", "ICEHOCKEY", "AMERICANFOOTBALL"];

  // One page load per cycle: WS sends ALL sports data at once.
  // Live: load /apuestas-deportivas/live → WS sends all live matches.
  // Prematch: try /apuestas-deportivas/sports/1 (football, biggest prematch catalogue);
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

    // Inject before navigation: capture the uof-sports WS instance on window.__winamaxWS
    await page.addInitScript(`
      const _OrigWS = window.WebSocket;
      window.WebSocket = function(url, proto) {
        const ws = new _OrigWS(url, proto);
        if (typeof url === 'string' && url.includes('uof-sports')) {
          window.__winamaxWS = ws;
        }
        return ws;
      };
      window.WebSocket.prototype = _OrigWS.prototype;
    `);

    const wsMessages: Array<{ url: string; payload: string }> = [];
    const wsState: Record<string, any> = {};
    const sentFrames: string[] = [];
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
                // "m" is the historic event name; Winamax now also sends "message" with same structure
                if ((evtName === "m" || evtName === "message") && typeof arr[1] === "object" && arr[1] !== null) {
                  mergeWsMessage(wsState, arr[1]);
                } else if (typeof arr[1] === "object" && arr[1] !== null) {
                  wsState[evtName] = arr[1];
                }
              }
            } catch { /* */ }
          }
        }
      });
      // Capture frames sent BY the browser → reveals subscription events
      ws.on("framesent", (frame: any) => {
        const raw = frame.payload;
        const payload = typeof raw === "string" ? raw : (Buffer.isBuffer(raw) ? raw.toString("utf8") : "");
        if (payload.length > 5) sentFrames.push(payload.slice(0, 300));
      });
    });

    const events: ScrapedEvent[] = [];
    try {
      // Live: /apuestas-deportivas/live has WS data for ALL live sports in one shot.
      // Prematch: try Football page (biggest catalogue, WS sends all prematch too).
      const targetUrl = isLive
        ? `${BASE_ES}/apuestas-deportivas/live`
        : `${BASE_ES}/apuestas-deportivas/sports/${SPORT_IDS.FOOTBALL}`;

      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 55_000 }).catch(async (e: any) => {
        this.warn(`Goto ${targetUrl} failed (${e?.message?.slice(0, 60)}) — falling back to homepage`);
        await page.goto(`${BASE_ES}/apuestas-deportivas`, { waitUntil: "domcontentloaded", timeout: 40_000 });
      });
      await dismissCookies(page);
      const waitResult = await waitForWsOrRest(page, wsState, wsMessages, captured, 12_000);
      if (waitResult === "timeout") {
        this.warn(`${isLive ? "Live" : "Prematch"}: sin datos WS ni REST en 12s — posible bloqueo de Winamax`);
      } else if (waitResult === "ws_empty") {
        this.log(`${isLive ? "Live" : "Prematch"}: WS conectó pero sin partidos (estado legítimo)`);
      }

      // Subscribe to live matches in batches to load match/bet/odds data from WS.
      // Without subscription the live page WS only sends metadata — no match-level data.
      // BATCH=20, 1000ms between batches, 2000ms final: ~5s for 40 matches (vs 10.5s old BATCH=10).
      const wsRoot = resolveWsStateRoot(wsState);
      if (waitResult === "ws_data") {
        const allLiveIds = Object.values(wsRoot.matches ?? {})
          .filter((m: any) => m && typeof m === "object")
          .map((m: any) => String(m.matchId ?? m.id ?? ""))
          .filter(Boolean);

        // Cap at 200: 200 matches × 500ms/batch = 5s, well within the 60s orchestrator timeout.
        // With 468+ live matches the old 24s subscription loop regularly exceeded 60s.
        const MAX_LIVE_SUBS = 200;
        const matchIds = allLiveIds.slice(0, MAX_LIVE_SUBS);

        if (matchIds.length > 0) {
          const betsBefore = Object.keys(wsRoot.bets ?? {}).length;
          const cappedNote = allLiveIds.length > MAX_LIVE_SUBS ? ` (capped from ${allLiveIds.length})` : "";
          this.log(`WS live subscription: ${matchIds.length} matches${cappedNote}`);
          const BATCH = 20;
          for (let i = 0; i < matchIds.length; i += BATCH) {
            const batch = matchIds.slice(i, i + BATCH);
            await page.evaluate((ids: string[]) => {
              const ws = (window as any).__winamaxWS as WebSocket | undefined;
              if (!ws || ws.readyState !== 1) return;
              for (const id of ids) {
                ws.send(`42["m",{"route":"match:${id}"}]`);
              }
            }, batch).catch(() => {});
            await new Promise<void>((r) => setTimeout(r, 500));
          }
          await new Promise<void>((r) => setTimeout(r, 1000));
          const betsAfter = Object.keys(resolveWsStateRoot(wsState).bets ?? {}).length;
          this.log(`WS live subscription done: bets ${betsBefore} → ${betsAfter}`);
        }
      }

      // Scroll to trigger SPA lazy-loading of secondary market WS subscriptions
      await autoScrollForSecondaryMarkets(page, wsState, (msg) => this.log(msg), 4, 800, 800);

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

      const matchCount = Object.keys(wsRoot.matches ?? {}).length;

      for (const sport of this.sports) {
        if (wsStateKeys.length > 0) {
          const wsEvents = parseWinamaxWsState(wsState, sport, isLive, (msg) => this.log(msg));
          if (wsEvents.length > 0) {
            this.log(`WS ${isLive ? "live" : "prematch"} ${sport}: ${wsEvents.length} events`);
            events.push(...wsEvents);
          } else {
            const sportId = SPORT_IDS[sport];
            const wsRoot2 = resolveWsStateRoot(wsState);
            const sportMatches = Object.values(wsRoot2.matches ?? {}).filter(
              (m: any) => {
                const sid = m?.sportId;
                if (sid !== sportId && String(sid) !== String(sportId)) return false;
                if (!isLive) return true;
                return m?.status === "LIVE" || m?.status === "IN_PLAY" || m?.status === "LIVE_EVENT"
                  || m?.status === "PLAYING" || m?.is_live === true || m?.match_status === 1 || m?.isLive === true;
              }
            ).length;
            const statusSample = [...new Set(
              Object.values(wsRoot2.matches ?? {}).slice(0, 8).map((m: any) => m?.status ?? "?")
            )].join(",");
            this.warn(`WS 0 events for ${sport} (id=${sportId}, total=${matchCount}, ${isLive ? "live" : "pre"}=${sportMatches}, statuses=${statusSample})`);
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

    await page.addInitScript(`
      const _OrigWS = window.WebSocket;
      window.WebSocket = function(url, proto) {
        const ws = new _OrigWS(url, proto);
        if (typeof url === 'string' && url.includes('uof-sports')) {
          window.__winamaxWS = ws;
        }
        return ws;
      };
      window.WebSocket.prototype = _OrigWS.prototype;
    `);

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
                // "m" is the historic event name; Winamax now also sends "message" with same structure
                if ((evtName === "m" || evtName === "message") && typeof arr[1] === "object" && arr[1] !== null) {
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
      // Football (sport 1) is the default sport — its specific URL /sports/1
      // is more aggressively Cloudflare-gated than other sport pages.
      // Use the SPA homepage which loads football data by default.
      const url = sport === "FOOTBALL"
        ? `${BASE_ES}/apuestas-deportivas`
        : `${BASE_ES}/apuestas-deportivas/sports/${SPORT_IDS[sport]}`;
      let gotoFailed = false;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 55_000 }).catch(async (e: any) => {
        this.warn(`Prematch ${sport} goto failed (${e?.message?.slice(0, 60)}) — retrying sports/1`);
        gotoFailed = true;
        if (sport === "FOOTBALL") {
          await page.goto(`${BASE_ES}/apuestas-deportivas/sports/${SPORT_IDS.FOOTBALL}`, {
            waitUntil: "domcontentloaded", timeout: 30_000,
          }).catch((e2: any) => {
            this.warn(`Prematch ${sport} retry also failed (${e2?.message?.slice(0, 50)}) — skip`);
          });
          gotoFailed = page.isClosed();
        }
      });
      if (gotoFailed && page.isClosed()) {
        return events;
      }
      await dismissCookies(page);
      // Football has far more competitions/matches than other sports — give it 25s to load WS data
      const wsTimeout = sport === "FOOTBALL" ? 25_000 : 12_000;
      const waitResult = await waitForWsOrRest(page, wsState, wsMessages, captured, wsTimeout);
      if (waitResult === "timeout") {
        this.warn(`Prematch ${sport}: sin datos WS ni REST en ${wsTimeout / 1000}s — posible bloqueo`);
      }

      const wsRootP = resolveWsStateRoot(wsState);
      if (waitResult === "ws_data") {
        const allMatchIds = Object.values(wsRootP.matches ?? {})
          .filter((m: any) => m && typeof m === "object")
          .map((m: any) => String(m.matchId ?? m.id ?? ""))
          .filter(Boolean);

        // Cap at 200 to avoid 100+ second blocking subscription loops that starve the LIVE cycle.
        const MAX_PREMATCH_SUBS = 200;
        const matchIds = allMatchIds.slice(0, MAX_PREMATCH_SUBS);

        if (matchIds.length > 0) {
          const betsBefore = Object.keys(wsRootP.bets ?? {}).length;
          const nullBefore = Object.values(wsRootP.bets ?? {}).filter((b: any) => b === null).length;
          const cappedNote = allMatchIds.length > MAX_PREMATCH_SUBS ? ` (capped from ${allMatchIds.length})` : "";
          this.log(`WS prematch ${sport} subscription: ${matchIds.length} matches${cappedNote}`);

          const BATCH = 20;
          for (let i = 0; i < matchIds.length; i += BATCH) {
            const batch = matchIds.slice(i, i + BATCH);
            await page.evaluate((ids: string[]) => {
              const ws = (window as any).__winamaxWS as WebSocket | undefined;
              if (!ws || ws.readyState !== 1) return;
              for (const id of ids) {
                ws.send(`42["m",{"route":"match:${id}"}]`);
              }
            }, batch).catch(() => {});
            await new Promise<void>((r) => setTimeout(r, 1000));
          }

          await new Promise<void>((r) => setTimeout(r, 3000));
          const wsRootP2 = resolveWsStateRoot(wsState);
          const betsAfter = Object.keys(wsRootP2.bets ?? {}).length;
          const nullAfter = Object.values(wsRootP2.bets ?? {}).filter((b: any) => b === null).length;
          this.log(`WS prematch ${sport} subscription done: bets ${betsBefore}(null=${nullBefore}) → ${betsAfter}(null=${nullAfter})`);
        }
      }

      // Scroll to trigger SPA lazy-loading of secondary prematch markets
      await autoScrollForSecondaryMarkets(page, wsState, (msg) => this.log(msg), 5, 800, 1200);

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
        const fallback = parseWinamaxData(wsRootP, sport, false, "ws-state");
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
