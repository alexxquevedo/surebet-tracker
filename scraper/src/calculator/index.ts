import { normalizeTeam, teamSimilarity } from "../matcher/normalize";
import type {
  H2HOutcome,
  TotalsLine,
  PlayerPropLine,
  MarketOutcomes,
  GroupedMarket,
  DetectedSurebet,
  DetectedMiddle,
  DetectedArb,
  ArbLeg,
} from "../types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isH2H(outcomes: MarketOutcomes): outcomes is H2HOutcome[] {
  return outcomes.length > 0 && "odds" in outcomes[0];
}

function isTotals(outcomes: MarketOutcomes): outcomes is TotalsLine[] {
  return outcomes.length > 0 && "line" in outcomes[0] && !("player" in outcomes[0]);
}

function isPlayerProps(outcomes: MarketOutcomes): outcomes is PlayerPropLine[] {
  return outcomes.length > 0 && "player" in outcomes[0];
}

/**
 * Kelly-style equal-profit stake distribution.
 * Returns stake % for each leg such that profit is equal regardless of which wins.
 */
function distributeStakes(odds: number[]): number[] {
  // For equal return: stake_i = (1/odds_i) / sum(1/odds_j)
  const impliedProbs = odds.map((o) => 1 / o);
  const total = impliedProbs.reduce((a, b) => a + b, 0);
  return impliedProbs.map((p) => parseFloat(((p / total) * 100).toFixed(2)));
}

// ─── Outcome name normalization ───────────────────────────────────────────────

/**
 * Bookmakers use different names for the same outcome:
 * - Draw: "X" (Winamax/FR), "Draw" (Betsson/EN), "Empate" (ES), "Nul" (FR), "Nula" (PT)
 * - Home/Away: "1"/"2" or team names — team names are kept as-is for readability.
 *
 * Normalizing to a canonical name lets the calculator merge the draw selection
 * even when bookmakers encode it differently, enabling cross-bookmaker arb detection.
 */
function normalizeOutcomeName(name: string): string {
  const t = name.trim();
  if (/^x$/i.test(t) || /^empate$/i.test(t) || /^nul[ae]?$/i.test(t) || /^draw$/i.test(t)) {
    return "Draw";
  }
  // Apply the same pipeline as normalizeTeam: diacritics + language aliases + suffix strip.
  // This ensures "Filipinas" == "Philippines", "Pays-Bas" == "Netherlands", etc.
  return normalizeTeam(t);
}

// ─── Surebet detection (h2h) ─────────────────────────────────────────────────

/**
 * For each outcome name (Home, Draw, Away), finds the best odds across all bookmakers.
 * If sum of implied probs < 1 → surebet exists.
 */
export function detectSurebet(market: GroupedMarket): DetectedSurebet | null {
  if (market.market !== "h2h" && market.market !== "handicap") return null;

  // Live h2h odds above this threshold are almost certainly stale/suspended prices
  const MAX_LIVE_H2H_ODDS = 12.0;

  // Collect all unique selection names across all bookmakers (normalized)
  const allNames = new Set<string>();
  for (const outcomes of market.byBook.values()) {
    if (isH2H(outcomes)) outcomes.forEach((o) => allNames.add(normalizeOutcomeName(o.name)));
  }

  // Normalize outcome names to positions using eventKey teams:
  // eventKey format: sport:teamA:teamB:date (teams alphabetically sorted after normalizeTeam).
  // Books like WilliamHill use '1'/'2'/'X'; others (codere, winamax) use team names.
  // Map each outcome name to '1', 'X', or '2' so they match across books.
  const ekParts = market.eventKey.split(":").slice(1); // drop sport prefix
  const teamA = ekParts.length >= 1 ? ekParts[0] : null; // alpha-first team (normalized in key)
  const teamB = ekParts.length >= 2 ? ekParts[1].replace(/:[0-9]{4}-[0-9]{2}-[0-9]{2}$|:nodate$/, "") : null;
  const nameToPos = new Map<string, "1" | "X" | "2">();
  for (const name of allNames) {
    if (name === "1") { nameToPos.set(name, "1"); continue; }
    if (name === "2") { nameToPos.set(name, "2"); continue; }
    if (name === "Draw") { nameToPos.set(name, "X"); continue; }
    if (!teamA || !teamB) continue;
    const nt = normalizeTeam(name);
    const simA = teamSimilarity(nt, teamA);
    const simB = teamSimilarity(nt, teamB);
    if (simA >= 0.7 && simA > simB) nameToPos.set(name, "1");
    else if (simB >= 0.7 && simB > simA) nameToPos.set(name, "2");
  }
  // Use positions if ALL names were mapped — collapses 5-name mixed set to 3-name positional set
  const positionNames = new Set(["1", "X", "2"]);
  const allMapped = [...allNames].every(n => nameToPos.has(n));
  const effectiveNames = allMapped ? positionNames : allNames;

  // For each selection, find best odds + which bookmaker offers them
  let bestPerSelection: Array<{
    name: string;
    odds: number;
    bookmaker: string;
  }> = [];

  for (const pos of effectiveNames) {
    let bestOdds = 0;
    let bestBook = "";
    for (const [book, outcomes] of market.byBook) {
      if (!isH2H(outcomes)) continue;
      for (const o of outcomes) {
        const oNorm = normalizeOutcomeName(o.name);
        // Check if this outcome maps to current position
        const oPos = allMapped ? (nameToPos.get(oNorm) ?? null) : oNorm;
        if (oPos !== pos) continue;
        if (o.odds > bestOdds) { bestOdds = o.odds; bestBook = book; }
      }
    }
    if (bestOdds > 0) bestPerSelection.push({ name: pos, odds: bestOdds, bookmaker: bestBook });
  }

  if (bestPerSelection.length < 2) return null;

  // Reject live arbs where any leg has suspiciously high odds — almost certainly stale
  if (market.isLive && bestPerSelection.some((s) => s.odds > MAX_LIVE_H2H_ODDS)) return null;

  // Each outcome must come from a different bookmaker — one bookie covering two legs
  // of the same market is not a real surebet (requires 3+ bookmakers for 3-way markets).
  // Positional fallback: for 2-way markets (basketball, tennis) bookmakers may use
  // different name aliases (e.g. "Boston Celtics" vs "BOS Celtics"). When name-based
  // matching produces more names than books, try position-based matching instead.
  const usedBooks = new Set(bestPerSelection.map((s) => s.bookmaker));
  // Each outcome must come from a different bookmaker.
  // Positional fallback removed: it compared teams by array position, not by name,
  // causing false positives when bookmakers list the same two teams in different order.
  if (usedBooks.size < bestPerSelection.length) return null;

  const impliedSum = bestPerSelection.reduce((sum, s) => sum + 1 / s.odds, 0);
  if (impliedSum >= 1) return null; // No arb

  const profitPct = parseFloat(((1 / impliedSum - 1) * 100).toFixed(2));

  // Safety cap: profits above these thresholds are almost certainly parsing errors or stale prices.
  // Empirically, live codere vs WH tennis arbs run 6-9% (books lag behind each other on live updates).
  // Prematch WH vs winamax/codere can diverge 4-7% on minor-league baseball and ATP qualifiers.
  const PROFIT_CAP_LIVE = 9.0;
  const PROFIT_CAP_PREMATCH = 7.0;
  const cap = market.isLive ? PROFIT_CAP_LIVE : PROFIT_CAP_PREMATCH;
  // Silent skip: profit >15% is almost certainly settled/suspended odds — too noisy to log
  if (profitPct > 15) return null;
  if (profitPct > cap) {
    console.warn(
      `[calculator] Anomaly: ${market.eventKey} ${market.market} ${profitPct.toFixed(2)}% > cap ${cap}% discarded`,
      bestPerSelection.map((s) => `${s.bookmaker}:${s.name}@${s.odds}`).join(", "),
    );
    return null;
  }

  const stakes = distributeStakes(bestPerSelection.map((s) => s.odds));

  const legs: ArbLeg[] = bestPerSelection.map((s, i) => ({
    bookmaker: s.bookmaker,
    selection: s.name,
    odds: s.odds,
    stake: stakes[i],
  }));

  return {
    type: "SUREBET",
    sport: market.sport,
    isLive: market.isLive,
    startTime: market.startTime,
    eventKey: market.eventKey,
    eventName: market.eventName,
    league: market.league,
    market: market.market,
    profitPct,
    legs,
  };
}

// ─── Middle detection (totals) ────────────────────────────────────────────────

/** P(X = k) for a Poisson distribution with given lambda */
function poissonPmf(lambda: number, k: number): number {
  if (k < 0 || lambda <= 0) return 0;
  // Use log-space to avoid overflow for large k
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Probability that result falls strictly inside (windowLow, windowHigh).
 * Uses a Poisson approximation with λ = midpoint of the window.
 * For a 1-unit window (e.g. 9.5–10.5) this gives ~P(X = 10).
 */
function approxMiddleProbability(windowLow: number, windowHigh: number): number {
  const lambda = (windowLow + windowHigh) / 2;
  const kMin = Math.floor(windowLow) + 1;
  const kMax = Math.floor(windowHigh);
  let prob = 0;
  for (let k = kMin; k <= kMax; k++) prob += poissonPmf(lambda, k);
  return parseFloat(Math.min(prob, 1).toFixed(4));
}

/**
 * Finds RISK-FREE middles in totals markets.
 *
 * A risk-free middle exists when:
 *   Book A: Over X @ o1   Book B: Under Y @ o2   (Y > X, different books)
 *   AND (o1 − 1)(o2 − 1) > 1  ←→  1/o1 + 1/o2 < 1
 *
 * This means EVEN IF the window [X, Y] misses, one of the legs still
 * returns a profit on the total stakes — so the worst case is ≥ 0%.
 * If the result falls inside the window both legs win → maximum profit.
 */
export function detectMiddles(market: GroupedMarket): DetectedMiddle[] {
  const middles: DetectedMiddle[] = [];

  // Max plausible live odds for O/U markets — anything higher is a stale/suspended line
  const MAX_LIVE_ODDS = 12.0;

  // Gather all (line, over, under, bookmaker) from all books
  const allLines: Array<{ bookmaker: string; line: number; over: number; under: number }> = [];
  for (const [book, outcomes] of market.byBook) {
    if (!isTotals(outcomes)) continue;
    for (const t of outcomes) allLines.push({ bookmaker: book, line: t.line, over: t.over, under: t.under });
  }

  for (let i = 0; i < allLines.length; i++) {
    for (let j = 0; j < allLines.length; j++) {
      if (i === j) continue;
      const overSide  = allLines[i];
      const underSide = allLines[j];

      // Need: Over X from book A, Under Y from book B, with Y > X
      if (underSide.line <= overSide.line) continue;
      if (overSide.bookmaker === underSide.bookmaker) continue;

      const overOdds  = overSide.over;
      const underOdds = underSide.under;

      // Discard stale/suspended lines
      if (market.isLive && (overOdds > MAX_LIVE_ODDS || underOdds > MAX_LIVE_ODDS)) continue;

      // Stakes that equalise the two miss-case returns:
      // s1*(overOdds−1) − s2 = s2*(underOdds−1) − s1  →  s1/s2 = underOdds/overOdds
      const s1 = underOdds / (overOdds + underOdds); // stake on Over
      const s2 = 1 - s1;                              // stake on Under

      const missOverWins  = s1 * (overOdds  - 1) - s2; // Over wins, Under loses
      const missUnderWins = s2 * (underOdds - 1) - s1; // Under wins, Over loses
      const worstMissProfit = Math.min(missOverWins, missUnderWins);

      // RISK-FREE condition: miss case must also be profitable (no money lost)
      if (worstMissProfit < 0) continue;

      const hitReturn  = s1 * overOdds + s2 * underOdds - 1;
      const profitPct  = parseFloat((worstMissProfit * 100).toFixed(2)); // guaranteed min
      const maxProfitPct = parseFloat((hitReturn * 100).toFixed(2));     // hit max

      // Require meaningful upside when window hits
      if (maxProfitPct < 5) continue;

      const middleProbability = approxMiddleProbability(overSide.line, underSide.line);

      const legs: ArbLeg[] = [
        { bookmaker: overSide.bookmaker,  selection: `Over ${overSide.line}`,  odds: overOdds,  stake: parseFloat((s1 * 100).toFixed(2)) },
        { bookmaker: underSide.bookmaker, selection: `Under ${underSide.line}`, odds: underOdds, stake: parseFloat((s2 * 100).toFixed(2)) },
      ];

      middles.push({
        type: "MIDDLE",
        sport: market.sport,
        isLive: market.isLive,
        startTime: market.startTime,
        eventKey: market.eventKey,
        eventName: market.eventName,
        league: market.league,
        market: market.market,   // e.g. "goals", "corners" — window info is in the leg selections
        profitPct,               // min guaranteed
        maxProfitPct,            // max (when window hits)
        worstLoss: profitPct,    // same as profitPct (no loss, kept for DB compat)
        windowLow: overSide.line,
        windowHigh: underSide.line,
        middleProbability,
        legs,
      });
    }
  }

  return middles;
}

// ─── Player props surebet detection ──────────────────────────────────────────

/**
 * Detects Over/Under surebets in player prop markets.
 * Groups by (player, stat, line) — finds the best Over from any bookmaker
 * and the best Under from any bookmaker, checks if combined implied prob < 1.
 *
 * Example: Winamax offers Champagnie +19.5 PRA @2.1, Bet365 offers -19.5 @2.05
 * → implied = 1/2.1 + 1/2.05 = 0.476 + 0.488 = 0.964 → surebet 3.73%
 */
export function detectPlayerPropSurebets(market: GroupedMarket): DetectedSurebet[] {
  if (market.market !== "player_props") return [];

  // key = "player::stat::line" → best {over: {odds, book}, under: {odds, book}}
  type Best = { odds: number; book: string };
  const propMap = new Map<string, { over: Best | null; under: Best | null }>();

  const MAX_LIVE_ODDS = 12.0;
  for (const [book, outcomes] of market.byBook) {
    if (!isPlayerProps(outcomes)) continue;
    for (const prop of outcomes) {
      if (market.isLive && (prop.over > MAX_LIVE_ODDS || prop.under > MAX_LIVE_ODDS)) continue;
      const key = `${prop.player}::${prop.stat}::${prop.line}`;
      const cur = propMap.get(key) ?? { over: null, under: null };
      if (prop.over  >= 1.01 && (!cur.over  || prop.over  > cur.over.odds))  cur.over  = { odds: prop.over,  book };
      if (prop.under >= 1.01 && (!cur.under || prop.under > cur.under.odds)) cur.under = { odds: prop.under, book };
      propMap.set(key, cur);
    }
  }

  const surebets: DetectedSurebet[] = [];

  for (const [key, { over, under }] of propMap) {
    if (!over || !under || over.book === under.book) continue; // must be different bookmakers
    const implied = 1 / over.odds + 1 / under.odds;
    if (implied >= 1.0) continue;
    const profitPct = parseFloat(((1 / implied - 1) * 100).toFixed(2));
    const [player, stat, lineStr] = key.split("::");
    const line = parseFloat(lineStr);
    const stakes = distributeStakes([over.odds, under.odds]);
    surebets.push({
      type: "SUREBET",
      sport: market.sport,
      isLive: market.isLive,
      startTime: market.startTime,
      eventKey: market.eventKey,
      eventName: market.eventName,
      league: market.league,
      market: "player_props",
      profitPct,
      legs: [
        { bookmaker: over.book,  selection: `${player} +${line} ${stat}`, odds: over.odds,  stake: stakes[0] },
        { bookmaker: under.book, selection: `${player} -${line} ${stat}`, odds: under.odds, stake: stakes[1] },
      ],
    });
  }

  return surebets;
}

// ─── Generic Over/Under surebet detection (corners, goals, cards, etc.) ──────

/**
 * For any over/under market (not player props): find same-line Over from book A
 * and Under from book B where combined implied probability < 1.
 * Works for corners, goals, yellow cards, aces, games, sets, etc.
 */
export function detectOverUnderSurebets(market: GroupedMarket): DetectedSurebet[] {
  const MAX_LIVE_ODDS = 12.0;
  type Best = { odds: number; book: string };
  const lineMap = new Map<number, { over: Best | null; under: Best | null }>();

  for (const [book, outcomes] of market.byBook) {
    if (!isTotals(outcomes)) continue;
    for (const t of outcomes) {
      // Discard stale/suspended live lines
      if (market.isLive && (t.over > MAX_LIVE_ODDS || t.under > MAX_LIVE_ODDS)) continue;
      const cur = lineMap.get(t.line) ?? { over: null, under: null };
      if (t.over  >= 1.01 && (!cur.over  || t.over  > cur.over.odds))  cur.over  = { odds: t.over,  book };
      if (t.under >= 1.01 && (!cur.under || t.under > cur.under.odds)) cur.under = { odds: t.under, book };
      lineMap.set(t.line, cur);
    }
  }

  const surebets: DetectedSurebet[] = [];
  for (const [line, { over, under }] of lineMap) {
    if (!over || !under || over.book === under.book) continue;
    const implied = 1 / over.odds + 1 / under.odds;
    if (implied >= 1.0) continue;
    const profitPct = parseFloat(((1 / implied - 1) * 100).toFixed(2));
    const stakes = distributeStakes([over.odds, under.odds]);
    surebets.push({
      type: "SUREBET",
      sport: market.sport,
      isLive: market.isLive,
      startTime: market.startTime,
      eventKey: market.eventKey,
      eventName: market.eventName,
      league: market.league,
      market: `${market.market} O/U ${line}`,
      profitPct,
      legs: [
        { bookmaker: over.book,  selection: `Over ${line}`,  odds: over.odds,  stake: stakes[0] },
        { bookmaker: under.book, selection: `Under ${line}`, odds: under.odds, stake: stakes[1] },
      ],
    });
  }
  return surebets;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function findArbs(markets: GroupedMarket[], minProfitPct: number): DetectedArb[] {
  const arbs: DetectedArb[] = [];

  for (const market of markets) {
    if (market.market === "h2h" || market.market === "handicap") {
      const arb = detectSurebet(market);
      if (arb && arb.profitPct >= minProfitPct) arbs.push(arb);
    } else if (market.market === "player_props") {
      const props = detectPlayerPropSurebets(market);
      arbs.push(...props.filter((p) => p.profitPct >= minProfitPct));
    } else {
      // Generic over/under market (corners, goals, cards, games, sets, etc.)
      // Inspect outcome type to confirm TotalsLine before running detectors
      const sampleOutcomes = [...market.byBook.values()][0];
      if (!sampleOutcomes || !isTotals(sampleOutcomes)) continue;
      const surebets = detectOverUnderSurebets(market);
      arbs.push(...surebets.filter((s) => s.profitPct >= minProfitPct));
      const middles = detectMiddles(market);
      arbs.push(...dedupeMiddles(middles.filter((m) => m.profitPct >= minProfitPct)));
    }
  }

  return arbs;
}

/**
 * For the same event + same Over-leg (book + line), only keep the middle with the
 * highest hit-profit. This prevents 9 separate notifications for the same Over 1.5
 * paired against Under 2.5, 3.5, 4.5... 9.5 — a common live-football pattern.
 */
function dedupeMiddles(middles: DetectedMiddle[]): DetectedMiddle[] {
  // key = "eventName::overBook::overLine"
  const best = new Map<string, DetectedMiddle>();
  for (const m of middles) {
    const overLeg = m.legs.find((l) => l.selection.startsWith("Over "));
    if (!overLeg) continue;
    const key = `${m.eventName}::${overLeg.bookmaker}::${overLeg.selection}`;
    const prev = best.get(key);
    if (!prev || m.maxProfitPct > prev.maxProfitPct) best.set(key, m);
  }
  return [...best.values()];
}
